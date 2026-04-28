// StreamLoader background service worker
// Captures MP4 stream URLs via webRequest + messages from content script.

const tabStreams = new Map(); // tabId -> Map<url, streamInfo>
const tabTitles = new Map();  // tabId -> string (latest known page title)

// Open the side panel when the toolbar icon is clicked.
chrome.sidePanel
  ?.setPanelBehavior?.({ openPanelOnActionClick: true })
  .catch((err) => console.warn("StreamLoader: setPanelBehavior failed", err));

// Clean up any leftover dynamic rule from older versions that installed a
// static, generic Referer rewrite. The per-click session rule below replaces
// it and works for every tenant because it reads the active tab's origin.
if (chrome.declarativeNetRequest?.updateDynamicRules) {
  chrome.declarativeNetRequest
    .updateDynamicRules({ removeRuleIds: [1001] })
    .catch(() => {});
}

// --- Per-download session override -----------------------------------------
// Static rules can only set a single generic Referer per host. Many CDNs check
// that Referer matches the *specific* page URL, so we additionally install a
// short-lived session rule that targets one download URL with the active tab
// URL as its Referer (and the tab origin as Origin). Rule id 2001 is reused
// on every click so only the most recent override is live.
const SESSION_OVERRIDE_RULE_ID = 2001;
// Separate rule id used while generating side-panel thumbnails. Kept apart
// from the per-click download rule (2001) so a Download click during thumb
// generation doesn't stomp on either override.
const SESSION_THUMB_RULE_ID = 2002;
// Resolution probes run as their own queue in parallel with the thumb queue,
// so a third rule id keeps their Referer/CORS override from clobbering the
// thumb override (or vice-versa) when both queues are active at once.
const SESSION_RES_RULE_ID = 2003;

async function setDownloadRefererOverride(targetUrl, referer, pageOrigin) {
  if (!chrome.declarativeNetRequest?.updateSessionRules) return;
  if (!targetUrl || !referer) return;

  // Use `|<origin><pathname>` as a prefix-anchored substring filter. This
  // matches the download URL including any querystring without having to
  // escape signature characters, which urlFilter can't always handle.
  let filter = targetUrl;
  try {
    const u = new URL(targetUrl);
    filter = `|${u.origin}${u.pathname}`;
  } catch (e) {
    /* fall back to full URL */
  }

  const requestHeaders = [
    { header: "referer", operation: "set", value: referer },
  ];

  // Inject CORS response headers so the fallback page-context fetch (see
  // sidepanel.js downloadViaPageContext) can read cross-origin response
  // bodies. Harmless for the direct chrome.downloads.download path, which
  // ignores CORS entirely. `allow-credentials: true` requires a specific
  // origin (not `*`), so we use the active tab's origin.
  const responseHeaders = [];
  if (pageOrigin) {
    responseHeaders.push(
      { header: "access-control-allow-origin", operation: "set", value: pageOrigin },
      { header: "access-control-allow-credentials", operation: "set", value: "true" },
      { header: "access-control-expose-headers", operation: "set", value: "content-length,content-type,content-range,accept-ranges" }
    );
  }

  const action = { type: "modifyHeaders", requestHeaders };
  if (responseHeaders.length) action.responseHeaders = responseHeaders;

  try {
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [SESSION_OVERRIDE_RULE_ID],
      addRules: [
        {
          id: SESSION_OVERRIDE_RULE_ID,
          priority: 100,
          action,
          condition: {
            urlFilter: filter,
            resourceTypes: [
              "xmlhttprequest",
              "media",
              "main_frame",
              "sub_frame",
              "other",
            ],
          },
        },
      ],
    });
  } catch (err) {
    console.warn("StreamLoader: failed to set session override", err);
  }
}

async function clearDownloadRefererOverride() {
  if (!chrome.declarativeNetRequest?.updateSessionRules) return;
  try {
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [SESSION_OVERRIDE_RULE_ID],
    });
  } catch (err) {
    /* best-effort cleanup */
  }
}

// Same shape as the download override but on a separate rule id so the two
// don't clobber each other. Also injects CORS response headers so the side
// panel's <video crossOrigin="anonymous"> can paint frames into a non-tainted
// canvas. Used by both the thumbnail queue (rule 2002) and the resolution
// probe queue (rule 2003), which run independently.
async function setSidePanelOverride(ruleId, targetUrl, referer, pageOrigin) {
  if (!chrome.declarativeNetRequest?.updateSessionRules) return;
  if (!targetUrl || !referer) return;

  let filter = targetUrl;
  try {
    const u = new URL(targetUrl);
    filter = `|${u.origin}${u.pathname}`;
  } catch (e) {
    /* fall back to full URL */
  }

  const requestHeaders = [
    { header: "referer", operation: "set", value: referer },
  ];
  const responseHeaders = [];
  if (pageOrigin) {
    responseHeaders.push(
      { header: "access-control-allow-origin", operation: "set", value: pageOrigin },
      { header: "access-control-allow-credentials", operation: "set", value: "true" },
      { header: "access-control-expose-headers", operation: "set", value: "content-length,content-type,content-range,accept-ranges" }
    );
  }

  const action = { type: "modifyHeaders", requestHeaders };
  if (responseHeaders.length) action.responseHeaders = responseHeaders;

  try {
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [ruleId],
      addRules: [
        {
          id: ruleId,
          priority: 100,
          action,
          condition: {
            urlFilter: filter,
            resourceTypes: [
              "xmlhttprequest",
              "media",
              "main_frame",
              "sub_frame",
              "other",
            ],
          },
        },
      ],
    });
  } catch (err) {
    console.warn("StreamLoader: failed to set side-panel override", ruleId, err);
  }
}

async function clearSidePanelOverride(ruleId) {
  if (!chrome.declarativeNetRequest?.updateSessionRules) return;
  try {
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [ruleId],
    });
  } catch (err) {
    /* best-effort cleanup */
  }
}

const MP4_URL_RE = /\.mp4(\?|#|$)/i;

function isMp4Url(url) {
  if (!url) return false;
  try {
    const u = new URL(url);
    if (MP4_URL_RE.test(u.pathname)) return true;
    // Some CDNs put the extension inside query params
    if (MP4_URL_RE.test(url)) return true;
  } catch (e) {
    return false;
  }
  return false;
}

function getStreamsForTab(tabId) {
  let m = tabStreams.get(tabId);
  if (!m) {
    m = new Map();
    tabStreams.set(tabId, m);
  }
  return m;
}

function updateBadge(tabId) {
  const m = tabStreams.get(tabId);
  const count = m ? m.size : 0;
  const text = count > 0 ? String(count) : "";
  chrome.action.setBadgeText({ tabId, text }).catch(() => {});
  if (count > 0) {
    chrome.action.setBadgeBackgroundColor({ tabId, color: "#2563eb" }).catch(() => {});
  }
}

function rememberTitle(tabId) {
  if (tabId == null || tabId < 0) return;
  if (tabTitles.has(tabId)) return;
  chrome.tabs.get(tabId).then(
    (tab) => {
      if (tab && tab.title) tabTitles.set(tabId, tab.title);
    },
    () => {}
  );
}

function addStream(tabId, info) {
  if (tabId == null || tabId < 0) return;
  if (!info || !info.url) return;
  if (!isMp4Url(info.url)) return;
  rememberTitle(tabId);
  const m = getStreamsForTab(tabId);
  const existing = m.get(info.url);
  if (existing) {
    // Merge — keep the best known size
    if (info.size && (!existing.size || info.size > existing.size)) {
      existing.size = info.size;
    }
    if (info.source && !existing.sources.includes(info.source)) {
      existing.sources.push(info.source);
    }
    return;
  }
  m.set(info.url, {
    url: info.url,
    size: info.size || null,
    mime: info.mime || null,
    addedAt: Date.now(),
    sources: [info.source || "network"],
    thumb: null, // data: URL, populated by side panel after generation
    width: null, // captured during thumb generation (loadedmetadata)
    height: null,
  });
  updateBadge(tabId);
}

function setStreamMeta(tabId, url, meta) {
  const m = tabStreams.get(tabId);
  if (!m) return false;
  const entry = m.get(url);
  if (!entry) return false;
  if (meta.thumb !== undefined) entry.thumb = meta.thumb || null;
  if (meta.width) entry.width = meta.width;
  if (meta.height) entry.height = meta.height;
  return true;
}

// Network-based detection
chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (details.tabId < 0) return;
    if (!isMp4Url(details.url)) return;
    addStream(details.tabId, { url: details.url, source: "network" });
  },
  { urls: ["<all_urls>"] }
);

// Capture content-length / content-type when we can see response headers
chrome.webRequest.onHeadersReceived.addListener(
  (details) => {
    if (details.tabId < 0) return;
    if (!isMp4Url(details.url)) return;
    let size = null;
    let mime = null;
    for (const h of details.responseHeaders || []) {
      const name = h.name.toLowerCase();
      if (name === "content-length" && h.value) {
        const n = parseInt(h.value, 10);
        if (!Number.isNaN(n)) size = n;
      } else if (name === "content-type" && h.value) {
        mime = h.value;
      }
    }
    addStream(details.tabId, { url: details.url, size, mime, source: "network" });
  },
  { urls: ["<all_urls>"] },
  ["responseHeaders"]
);

// Clear state on navigation / tab close
chrome.webNavigation?.onBeforeNavigate?.addListener?.((details) => {
  if (details.frameId === 0) {
    tabStreams.delete(details.tabId);
    updateBadge(details.tabId);
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  tabStreams.delete(tabId);
  tabTitles.delete(tabId);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "loading" && changeInfo.url) {
    tabStreams.delete(tabId);
    tabTitles.delete(tabId);
    updateBadge(tabId);
  }
  if (changeInfo.title) {
    tabTitles.set(tabId, changeInfo.title);
  }
});

// Messaging: popup + content script
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return;

  if (msg.type === "SL_REPORT_DOM_STREAMS") {
    const tabId = sender.tab?.id;
    if (tabId != null && Array.isArray(msg.urls)) {
      for (const url of msg.urls) {
        addStream(tabId, { url, source: "dom" });
      }
    }
    sendResponse({ ok: true });
    return;
  }

  if (msg.type === "SL_GET_STREAMS") {
    const tabId = msg.tabId;
    const m = tabStreams.get(tabId);
    const list = m ? Array.from(m.values()) : [];
    list.sort((a, b) => b.addedAt - a.addedAt);
    sendResponse({ streams: list });
    return;
  }

  if (msg.type === "SL_GET_TAB_TITLE") {
    const tabId = msg.tabId;
    const cached = tabTitles.get(tabId);
    if (cached) {
      sendResponse({ title: cached });
    } else {
      chrome.tabs.get(tabId).then(
        (tab) => {
          const t = tab?.title || "";
          if (t) tabTitles.set(tabId, t);
          sendResponse({ title: t });
        },
        () => sendResponse({ title: "" })
      );
      return true; // async response
    }
    return;
  }

  if (msg.type === "SL_CLEAR") {
    const tabId = msg.tabId;
    tabStreams.delete(tabId);
    updateBadge(tabId);
    sendResponse({ ok: true });
    return;
  }

  if (msg.type === "SL_SET_REFERER_OVERRIDE") {
    setDownloadRefererOverride(msg.url, msg.referer, msg.pageOrigin).then(
      () => sendResponse({ ok: true }),
      (err) => sendResponse({ ok: false, error: String(err) })
    );
    return true; // async
  }

  if (msg.type === "SL_CLEAR_REFERER_OVERRIDE") {
    clearDownloadRefererOverride().then(() => sendResponse({ ok: true }));
    return true;
  }

  if (msg.type === "SL_SET_THUMB_REFERER") {
    setSidePanelOverride(SESSION_THUMB_RULE_ID, msg.url, msg.referer, msg.pageOrigin).then(
      () => sendResponse({ ok: true }),
      (err) => sendResponse({ ok: false, error: String(err) })
    );
    return true;
  }

  if (msg.type === "SL_CLEAR_THUMB_REFERER") {
    clearSidePanelOverride(SESSION_THUMB_RULE_ID).then(() => sendResponse({ ok: true }));
    return true;
  }

  if (msg.type === "SL_SET_RES_REFERER") {
    setSidePanelOverride(SESSION_RES_RULE_ID, msg.url, msg.referer, msg.pageOrigin).then(
      () => sendResponse({ ok: true }),
      (err) => sendResponse({ ok: false, error: String(err) })
    );
    return true;
  }

  if (msg.type === "SL_CLEAR_RES_REFERER") {
    clearSidePanelOverride(SESSION_RES_RULE_ID).then(() => sendResponse({ ok: true }));
    return true;
  }

  if (msg.type === "SL_SET_STREAM_THUMB") {
    const ok = setStreamMeta(msg.tabId, msg.url, { thumb: msg.thumb });
    sendResponse({ ok });
    return;
  }

  if (msg.type === "SL_SET_STREAM_META") {
    const ok = setStreamMeta(msg.tabId, msg.url, {
      thumb: msg.thumb,
      width: msg.width,
      height: msg.height,
    });
    sendResponse({ ok });
    return;
  }
});
