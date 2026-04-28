// StreamLoader side panel script

const listEl = document.getElementById("list");
const statusEl = document.getElementById("status");
const toastEl = document.getElementById("toast");
const refreshBtn = document.getElementById("refresh");
const clearBtn = document.getElementById("clear");
const thumbsToggleBtn = document.getElementById("thumbs-toggle");
const tpl = document.getElementById("item-template");

let currentTabId = null;

// Downloads the side panel has started, so we can watch for interruptions
// and fall back to opening the URL in a new tab (Option C).
const pendingDownloads = new Map(); // downloadId -> { url, filename }
let toastTimer = null;

// Thumbnail generation state.
// - thumbCache: in-panel cache so re-renders within the same tab session
//   don't re-decode video (background also caches across sidepanel reloads).
// - thumbFailed: URLs whose thumbnail generation has already failed once;
//   skipped on subsequent renders until the user hits Refresh.
// - thumbQueue: sequential queue. We deliberately serialize to cap peak
//   memory at one decoded frame buffer (~8MB) regardless of stream count.
const thumbCache = new Map(); // url -> dataUrl
const resolutionCache = new Map(); // url -> { width, height }
const thumbFailed = new Set(); // url
const resolutionFailed = new Set(); // url
const thumbQueue = [];
const resolutionQueue = [];
let thumbWorking = false;
let resolutionWorking = false;
const THUMB_W = 160;
const THUMB_H = 90;
const THUMB_TIMEOUT_MS = 8000;
const RES_TIMEOUT_MS = 5000;

// Off by default — thumbnail generation is bandwidth-heavy on Referer-locked
// CDNs and most users only need the URL list. Toggled from the header button
// and persisted in chrome.storage.local across sessions.
let thumbsEnabled = false;
const THUMBS_ENABLED_KEY = "thumbsEnabled";

// Pin a small set of common heights to the labels people recognize.
// Anything outside the tolerance falls back to raw WIDTHxHEIGHT.
const RESOLUTION_TIERS = [
  { h: 4320, label: "8K" },
  { h: 2160, label: "4K" },
  { h: 1440, label: "1440p" },
  { h: 1080, label: "1080p" },
  { h: 720, label: "720p" },
  { h: 480, label: "480p" },
  { h: 360, label: "360p" },
  { h: 240, label: "240p" },
];

function formatResolution(width, height) {
  if (!width || !height) return "";
  for (const t of RESOLUTION_TIERS) {
    if (Math.abs(height - t.h) <= 30) return t.label;
  }
  return `${width}×${height}`;
}

function formatSize(bytes) {
  if (!bytes && bytes !== 0) return "";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let n = bytes;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(n < 10 && i > 0 ? 1 : 0)} ${units[i]}`;
}

function filenameFromUrl(url) {
  try {
    const u = new URL(url);
    const base = u.pathname.split("/").pop() || u.hostname;
    return decodeURIComponent(base);
  } catch (e) {
    return url;
  }
}

// Windows-safe filename: strip <>:"/\|?* and control chars, collapse whitespace,
// trim trailing dots/spaces, cap length, avoid reserved device names.
const WINDOWS_RESERVED_NAMES = new Set([
  "con", "prn", "aux", "nul",
  "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8", "com9",
  "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
]);

function sanitizeFilename(name) {
  if (!name) return "";
  let s = String(name)
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/g, "");
  // Cap at 100 chars so the full path (Downloads dir + name + ".mp4") stays
  // comfortably under Windows' 260-char MAX_PATH.
  if (s.length > 100) s = s.slice(0, 100).trim().replace(/[. ]+$/g, "");
  // Windows refuses reserved device names regardless of extension.
  if (WINDOWS_RESERVED_NAMES.has(s.toLowerCase())) s = `_${s}`;
  return s;
}

function ensureMp4Ext(name) {
  return /\.mp4$/i.test(name) ? name : `${name}.mp4`;
}

function getTabTitle(tabId) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: "SL_GET_TAB_TITLE", tabId }, (resp) => {
      if (chrome.runtime.lastError) {
        resolve("");
        return;
      }
      resolve(resp?.title || "");
    });
  });
}

async function buildDownloadFilename(stream, index, totalCount) {
  const fallback = filenameFromUrl(stream.url);
  const rawTitle = await getTabTitle(currentTabId);
  const safeTitle = sanitizeFilename(rawTitle);
  if (!safeTitle) return ensureMp4Ext(fallback);
  const suffix = totalCount > 1 ? ` (${index + 1})` : "";
  return ensureMp4Ext(`${safeTitle}${suffix}`);
}

function render(streams) {
  listEl.innerHTML = "";
  if (!streams.length) {
    statusEl.textContent =
      "No MP4 streams detected on this tab yet. Play the video and hit Refresh.";
    return;
  }
  statusEl.textContent = `${streams.length} stream${streams.length === 1 ? "" : "s"} found.`;

  streams.forEach((s, idx) => {
    const node = tpl.content.firstElementChild.cloneNode(true);
    node.querySelector(".index").textContent = `${idx + 1}.`;
    node.querySelector(".filename").textContent = filenameFromUrl(s.url);

    const thumbWrap = node.querySelector(".thumb");
    const thumbImg = node.querySelector(".thumb-img");
    const resEl = node.querySelector(".resolution");

    const cachedRes =
      (s.width && s.height ? { width: s.width, height: s.height } : null) ||
      resolutionCache.get(s.url);
    if (cachedRes) {
      applyResolution(resEl, cachedRes.width, cachedRes.height);
    } else if (!resolutionFailed.has(s.url)) {
      enqueueResolution(s.url, resEl);
    }

    const cached = s.thumb || thumbCache.get(s.url);
    if (cached) {
      applyThumb(thumbWrap, thumbImg, cached);
    } else if (thumbsEnabled && !thumbFailed.has(s.url)) {
      thumbWrap.classList.add("loading");
      enqueueThumb(s.url, thumbWrap, thumbImg, resEl);
    }

    node.querySelector(".copy").addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(s.url);
        flashButton(node.querySelector(".copy"), "Copied");
      } catch (e) {
        flashButton(node.querySelector(".copy"), "Failed");
      }
    });

    node.querySelector(".open").addEventListener("click", async () => {
      // Install the same per-URL Referer override used for downloads so a
      // plain tab navigation to a Referer-protected CDN also succeeds. The
      // override is left in place — the next Download/Open click will
      // replace rule 2001, and session rules die with the browser session.
      await installRefererOverride(s.url);
      chrome.tabs.create({ url: s.url });
    });

    node.querySelector(".download").addEventListener("click", async () => {
      const filename = await buildDownloadFilename(s, idx, streams.length);
      startDownload(s.url, filename);
    });

    listEl.appendChild(node);
  });
}

function applyThumb(wrap, img, dataUrl) {
  img.src = dataUrl;
  img.hidden = false;
  wrap.classList.remove("loading");
}

function applyResolution(el, width, height) {
  const label = formatResolution(width, height);
  if (!label) return;
  el.textContent = label;
  el.title = `${width}×${height}`;
  el.hidden = false;
}

function enqueueThumb(url, wrap, img, resEl) {
  thumbQueue.push({ url, wrap, img, resEl });
  if (!thumbWorking) processThumbQueue();
}

function enqueueResolution(url, resEl) {
  resolutionQueue.push({ url, resEl });
  if (!resolutionWorking) processResolutionQueue();
}

async function processResolutionQueue() {
  if (resolutionWorking) return;
  resolutionWorking = true;
  try {
    while (resolutionQueue.length) {
      const job = resolutionQueue.shift();
      // Skip if the thumb queue (or a previous probe) already populated this.
      if (resolutionCache.has(job.url)) {
        const r = resolutionCache.get(job.url);
        if (job.resEl?.isConnected) applyResolution(job.resEl, r.width, r.height);
        continue;
      }
      const dims = await probeResolution(job.url).catch(() => null);
      if (dims?.width && dims?.height) {
        resolutionCache.set(job.url, dims);
        if (job.resEl?.isConnected) applyResolution(job.resEl, dims.width, dims.height);
        if (currentTabId != null) {
          sendMessageAsync({
            type: "SL_SET_STREAM_META",
            tabId: currentTabId,
            url: job.url,
            width: dims.width,
            height: dims.height,
          });
        }
      } else {
        resolutionFailed.add(job.url);
      }
    }
  } finally {
    resolutionWorking = false;
  }
}

// Lighter than generateThumb: we only need the moov atom to read
// videoWidth/Height, so no seek and no canvas. Runs as its own queue
// (rule id 2003) so it doesn't sit behind in-flight thumb decodes.
async function probeResolution(url) {
  const ctx = await installRefererOverride_({
    setType: "SL_SET_RES_REFERER",
    url,
  });
  let video = null;
  let timer = null;
  try {
    return await new Promise((resolve, reject) => {
      video = document.createElement("video");
      video.crossOrigin = "anonymous";
      video.preload = "metadata";
      video.muted = true;
      video.playsInline = true;
      video.src = url;

      timer = setTimeout(() => reject(new Error("timeout")), RES_TIMEOUT_MS);

      const cleanup = () => {
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
      };

      video.addEventListener("error", () => {
        cleanup();
        reject(new Error("video error"));
      });

      video.addEventListener("loadedmetadata", () => {
        cleanup();
        resolve({ width: video.videoWidth || 0, height: video.videoHeight || 0 });
      });
    });
  } finally {
    if (video) {
      video.removeAttribute("src");
      try { video.load(); } catch (e) { /* ignore */ }
    }
    if (ctx) await sendMessageAsync({ type: "SL_CLEAR_RES_REFERER" });
  }
}

// Shared installer for thumb / resolution overrides — only the message type
// differs. Returns { origin } or null when the active tab can't be resolved.
async function installRefererOverride_({ setType, url }) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const tabUrl = tab?.url || "";
  if (!tabUrl) return null;
  let pageOrigin;
  try {
    pageOrigin = new URL(tabUrl).origin;
  } catch (e) {
    return null;
  }
  await sendMessageAsync({
    type: setType,
    url,
    referer: pageOrigin + "/",
    pageOrigin,
  });
  return { origin: pageOrigin };
}

async function processThumbQueue() {
  if (thumbWorking) return;
  thumbWorking = true;
  try {
    while (thumbQueue.length) {
      const job = thumbQueue.shift();
      // The DOM nodes may have been re-rendered out from under us (tab
      // switch, refresh). The cache check below still benefits later
      // renders, so we run the job either way.
      //
      // onMeta fires as soon as videoWidth/Height are known — that's
      // before the seek/draw completes, so resolution badges paint a
      // beat ahead of thumbnails.
      const onMeta = (width, height) => {
        if (!width || !height) return;
        resolutionCache.set(job.url, { width, height });
        if (job.resEl?.isConnected) applyResolution(job.resEl, width, height);
        if (currentTabId != null) {
          sendMessageAsync({
            type: "SL_SET_STREAM_META",
            tabId: currentTabId,
            url: job.url,
            width,
            height,
          });
        }
      };

      const result = await generateThumb(job.url, onMeta).catch(() => null);
      if (result?.thumb) {
        thumbCache.set(job.url, result.thumb);
        if (currentTabId != null) {
          sendMessageAsync({
            type: "SL_SET_STREAM_META",
            tabId: currentTabId,
            url: job.url,
            thumb: result.thumb,
            width: result.width,
            height: result.height,
          });
        }
        if (job.img.isConnected) applyThumb(job.wrap, job.img, result.thumb);
      } else {
        thumbFailed.add(job.url);
        if (job.wrap.isConnected) job.wrap.classList.remove("loading");
      }
    }
  } finally {
    thumbWorking = false;
  }
}

async function generateThumb(url, onMeta) {
  // Best-effort Referer override: many CDNs gate access on Referer, and we
  // also need the matching CORS response headers (set by the same DNR rule)
  // so crossOrigin="anonymous" produces a non-tainted canvas.
  const ctx = await installThumbRefererOverride(url);
  let video = null;
  let timer = null;
  let metaWidth = 0;
  let metaHeight = 0;
  try {
    return await new Promise((resolve, reject) => {
      video = document.createElement("video");
      video.crossOrigin = "anonymous";
      video.preload = "metadata";
      video.muted = true;
      video.playsInline = true;
      video.src = url;

      timer = setTimeout(() => reject(new Error("timeout")), THUMB_TIMEOUT_MS);

      const cleanup = () => {
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
      };

      video.addEventListener("error", () => {
        cleanup();
        reject(new Error("video error"));
      });

      video.addEventListener("loadedmetadata", () => {
        metaWidth = video.videoWidth || 0;
        metaHeight = video.videoHeight || 0;
        if (onMeta) {
          try { onMeta(metaWidth, metaHeight); } catch (e) { /* ignore */ }
        }
        const seekTo = Math.min(1, Math.max(0, (video.duration || 0) * 0.1));
        try {
          video.currentTime = seekTo;
        } catch (e) {
          cleanup();
          reject(e);
        }
      });

      video.addEventListener("seeked", () => {
        try {
          const canvas = document.createElement("canvas");
          canvas.width = THUMB_W;
          canvas.height = THUMB_H;
          const cctx = canvas.getContext("2d");
          cctx.drawImage(video, 0, 0, THUMB_W, THUMB_H);
          const dataUrl = canvas.toDataURL("image/jpeg", 0.7);
          cleanup();
          resolve({ thumb: dataUrl, width: metaWidth, height: metaHeight });
        } catch (e) {
          // Most likely SecurityError from a tainted canvas.
          cleanup();
          reject(e);
        }
      });
    });
  } finally {
    if (video) {
      video.removeAttribute("src");
      try { video.load(); } catch (e) { /* ignore */ }
    }
    if (ctx) await sendMessageAsync({ type: "SL_CLEAR_THUMB_REFERER" });
  }
}

async function installThumbRefererOverride(url) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const tabUrl = tab?.url || "";
  if (!tabUrl) return null;
  let pageOrigin;
  try {
    pageOrigin = new URL(tabUrl).origin;
  } catch (e) {
    return null;
  }
  await sendMessageAsync({
    type: "SL_SET_THUMB_REFERER",
    url,
    referer: pageOrigin + "/",
    pageOrigin,
  });
  return { origin: pageOrigin };
}

function flashButton(btn, text) {
  const prev = btn.textContent;
  btn.textContent = text;
  setTimeout(() => {
    btn.textContent = prev;
  }, 900);
}

function showToast(message, durationMs = 5000) {
  toastEl.textContent = message;
  toastEl.hidden = false;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toastEl.hidden = true;
    toastTimer = null;
  }, durationMs);
}

function sendMessageAsync(msg) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(msg, (resp) => {
        if (chrome.runtime.lastError) {
          resolve(null);
          return;
        }
        resolve(resp);
      });
    } catch (e) {
      resolve(null);
    }
  });
}

async function installRefererOverride(url) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const tabUrl = tab?.url || "";
  if (!tabUrl) return null;
  // Zoom (and most large sites) use the `origin-when-cross-origin` referrer
  // policy, so the browser actually sends just `https://<tenant>.zoom.us/` —
  // not the full page URL — as the Referer on cross-origin requests. We must
  // match that exactly.
  let pageOrigin;
  try {
    pageOrigin = new URL(tabUrl).origin;
  } catch (e) {
    return null;
  }
  await sendMessageAsync({
    type: "SL_SET_REFERER_OVERRIDE",
    url,
    referer: pageOrigin + "/",
    pageOrigin,
  });
  return { tabId: tab.id, origin: pageOrigin };
}

function clearRefererOverride() {
  sendMessageAsync({ type: "SL_CLEAR_REFERER_OVERRIDE" });
}

async function startDownload(url, filename) {
  // Install a per-URL Referer override (and CORS response headers, used by
  // the page-context fallback below) before kicking off the download.
  const ctx = await installRefererOverride(url);

  console.log("StreamLoader: starting download", { filename, urlLength: url.length });

  try {
    const downloadId = await chrome.downloads.download({ url, filename });
    if (downloadId == null) {
      clearRefererOverride();
      showToast("Download could not be started.", 6000);
      return;
    }
    pendingDownloads.set(downloadId, {
      url,
      filename,
      tabId: ctx?.tabId,
      origin: ctx?.origin,
    });
  } catch (err) {
    clearRefererOverride();
    showToast(
      `Download failed (${err?.message || "unknown error"}). The URL is still available via Copy URL.`,
      6000
    );
  }
}

// Fallback: run the download from inside the source tab's context, where
// cookies + referrer-policy all come for free. Requires the DNR session
// rule to have also injected CORS response headers (see background.js)
// so the cross-origin fetch can read the response body.
async function downloadViaPageContext(url, filename, tabId) {
  if (!tabId) {
    showToast(
      "Can't run page-context fallback — the source tab id is unknown.",
      8000
    );
    return;
  }
  showToast(
    "Direct download forbidden — retrying from the source tab. The whole file buffers into memory, so this may take a while and use a lot of RAM…",
    8000
  );
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      args: [url, filename],
      func: async (url, filename) => {
        try {
          const res = await fetch(url, {
            credentials: "include",
            cache: "no-store",
          });
          if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
          const blob = await res.blob();
          const size = blob.size;
          const blobUrl = URL.createObjectURL(blob);
          const a = document.createElement("a");
          a.href = blobUrl;
          a.download = filename;
          a.style.display = "none";
          document.body.appendChild(a);
          a.click();
          a.remove();
          setTimeout(() => URL.revokeObjectURL(blobUrl), 120000);
          return { ok: true, size };
        } catch (e) {
          return {
            ok: false,
            error: String(e?.message || e),
            name: e?.name || "",
          };
        }
      },
    });
    const r = results?.[0]?.result;
    if (r?.ok) {
      const mb = (r.size / 1024 / 1024).toFixed(1);
      showToast(`Page-context download started (${mb} MB).`, 6000);
    } else {
      const errMsg = r?.error || "unknown error";
      console.warn("StreamLoader: page-context download failed", r);
      showToast(`Page-context download failed: ${errMsg}`, 10000);
    }
  } catch (e) {
    console.warn("StreamLoader: executeScript threw", e);
    showToast(
      `Page-context fallback threw: ${e?.message || e}. The source tab may have been closed.`,
      10000
    );
  } finally {
    clearRefererOverride();
  }
}

// Catch downloads that start successfully but then fail mid-flight.
chrome.downloads?.onChanged?.addListener(async (delta) => {
  const info = pendingDownloads.get(delta.id);
  if (!info) return;
  if (delta.state?.current === "interrupted") {
    pendingDownloads.delete(delta.id);
    const reason = delta.error?.current || "unknown";
    console.warn("StreamLoader: download interrupted", {
      id: delta.id,
      reason,
      filename: info.filename,
      url: info.url,
    });

    // On SERVER_FORBIDDEN, the DNR Referer override either didn't apply to
    // the downloads-initiated request or the server also needs cookies that
    // Chrome drops on that path. Fall back to fetching from the source tab's
    // own context, which has both.
    if (reason === "SERVER_FORBIDDEN") {
      // Remove the ghost "failed" entry from the downloads history.
      try {
        await chrome.downloads.erase({ id: delta.id });
      } catch (e) {
        /* ignore */
      }
      await downloadViaPageContext(info.url, info.filename, info.tabId);
      return;
    }

    clearRefererOverride();
    const humanHint = explainInterruptReason(reason);
    showToast(`Download interrupted: ${reason}. ${humanHint}`, 10000);
  } else if (delta.state?.current === "complete") {
    pendingDownloads.delete(delta.id);
    clearRefererOverride();
  }
});

function explainInterruptReason(reason) {
  switch (reason) {
    case "FILE_NAME_TOO_LONG":
    case "FILE_TOO_LARGE":
      return "Filename/path is too long for Windows. Try moving your Downloads folder closer to the drive root, or let me tighten the filename cap.";
    case "FILE_ACCESS_DENIED":
      return "Windows blocked writing the file. Check that the Downloads folder is writable.";
    case "FILE_NO_SPACE":
      return "No disk space.";
    case "FILE_BLOCKED":
    case "FILE_SECURITY_CHECK_FAILED":
    case "FILE_VIRUS_INFECTED":
      return "Chrome Safe Browsing blocked the file.";
    case "NETWORK_FAILED":
    case "NETWORK_TIMEOUT":
    case "NETWORK_DISCONNECTED":
      return "Network error during download.";
    case "SERVER_FORBIDDEN":
    case "SERVER_UNAUTHORIZED":
      return "Server rejected the request — Referer/cookies may still be missing.";
    case "USER_CANCELED":
      return "Canceled.";
    default:
      return "URL is still copyable via Copy URL.";
  }
}

async function loadStreams() {
  if (currentTabId == null) return;
  chrome.runtime.sendMessage(
    { type: "SL_GET_STREAMS", tabId: currentTabId },
    (resp) => {
      if (chrome.runtime.lastError) {
        statusEl.textContent = `Error: ${chrome.runtime.lastError.message}`;
        return;
      }
      render(resp?.streams || []);
    }
  );
}

async function syncToActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  currentTabId = tab?.id ?? null;
  loadStreams();
}

function applyThumbsToggleUI() {
  thumbsToggleBtn.textContent = `Thumbs: ${thumbsEnabled ? "On" : "Off"}`;
  thumbsToggleBtn.classList.toggle("on", thumbsEnabled);
  document.body.classList.toggle("thumbs-off", !thumbsEnabled);
}

thumbsToggleBtn.addEventListener("click", () => {
  thumbsEnabled = !thumbsEnabled;
  applyThumbsToggleUI();
  chrome.storage?.local?.set?.({ [THUMBS_ENABLED_KEY]: thumbsEnabled });
  if (!thumbsEnabled) {
    // Drain pending thumb work; in-flight job finishes naturally and its
    // result is still cached, so a later re-enable reuses it.
    thumbQueue.length = 0;
  } else {
    // Re-enable: let previously skipped/failed thumbs be retried.
    thumbFailed.clear();
  }
  loadStreams();
});

refreshBtn.addEventListener("click", () => {
  // Let previously failed probes be retried on a manual refresh.
  thumbFailed.clear();
  resolutionFailed.clear();
  loadStreams();
});
clearBtn.addEventListener("click", () => {
  if (currentTabId == null) return;
  thumbCache.clear();
  resolutionCache.clear();
  thumbFailed.clear();
  resolutionFailed.clear();
  chrome.runtime.sendMessage({ type: "SL_CLEAR", tabId: currentTabId }, () => loadStreams());
});

// The side panel persists across tab switches — re-fetch when the active tab
// changes or when its URL finishes loading.
chrome.tabs.onActivated.addListener(() => {
  syncToActiveTab();
});
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (tabId !== currentTabId) return;
  if (changeInfo.status === "complete" || changeInfo.title) {
    loadStreams();
  }
});
chrome.windows?.onFocusChanged?.addListener?.(() => {
  syncToActiveTab();
});

(async function init() {
  try {
    const stored = await chrome.storage?.local?.get?.(THUMBS_ENABLED_KEY);
    if (stored && typeof stored[THUMBS_ENABLED_KEY] === "boolean") {
      thumbsEnabled = stored[THUMBS_ENABLED_KEY];
    }
  } catch (e) {
    /* default stays Off */
  }
  applyThumbsToggleUI();
  syncToActiveTab();
})();
