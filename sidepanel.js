// StreamLoader side panel script

const listEl = document.getElementById("list");
const statusEl = document.getElementById("status");
const toastEl = document.getElementById("toast");
const refreshBtn = document.getElementById("refresh");
const clearBtn = document.getElementById("clear");
const tpl = document.getElementById("item-template");

let currentTabId = null;

// Downloads the side panel has started, so we can watch for interruptions
// and fall back to opening the URL in a new tab (Option C).
const pendingDownloads = new Map(); // downloadId -> { url, filename }
let toastTimer = null;

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
    node.querySelector(".size").textContent = s.size ? formatSize(s.size) : "";

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

refreshBtn.addEventListener("click", loadStreams);
clearBtn.addEventListener("click", () => {
  if (currentTabId == null) return;
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

syncToActiveTab();
