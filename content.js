// StreamLoader content script
// Scans the DOM for <video>/<source> elements and reports MP4 URLs to the
// background service worker. Re-scans on DOM mutations so late-loaded players
// are captured too.

(function () {
  const MP4_RE = /\.mp4(\?|#|$)/i;

  function collectUrls(root) {
    const urls = new Set();
    const videos = root.querySelectorAll?.("video, source");
    if (!videos) return urls;
    for (const el of videos) {
      const candidates = [
        el.currentSrc,
        el.src,
        el.getAttribute?.("src"),
        el.getAttribute?.("data-src"),
      ];
      for (const c of candidates) {
        if (!c) continue;
        try {
          const abs = new URL(c, location.href).href;
          if (MP4_RE.test(abs)) urls.add(abs);
        } catch (e) {
          /* ignore */
        }
      }
    }
    return urls;
  }

  let pending = new Set();
  let flushTimer = null;

  function flush() {
    flushTimer = null;
    if (pending.size === 0) return;
    const urls = Array.from(pending);
    pending = new Set();
    try {
      chrome.runtime.sendMessage({ type: "SL_REPORT_DOM_STREAMS", urls });
    } catch (e) {
      // Extension context may be invalidated during reloads — ignore.
    }
  }

  function scheduleFlush() {
    if (flushTimer != null) return;
    flushTimer = setTimeout(flush, 250);
  }

  function scan() {
    const found = collectUrls(document);
    if (found.size === 0) return;
    for (const u of found) pending.add(u);
    scheduleFlush();
  }

  scan();

  const mo = new MutationObserver(() => scan());
  mo.observe(document.documentElement || document, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["src", "data-src"],
  });

  window.addEventListener("load", scan);
})();
