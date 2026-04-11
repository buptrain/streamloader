# StreamLoader

A Chrome (Manifest V3) extension that lists MP4 streams playing on the current
webpage and lets you save them with a filename based on the page title. Built
for students who want a local copy of their own course recordings for offline
study.

## Intended use

**StreamLoader is only for saving content you are personally authorized to
access and keep a copy of** — e.g. your own course recordings from a learning
management system, Zoom class replays you are enrolled in, conference talks
shared with you, etc.

Do not use this extension to:

- Redistribute, re-upload, or publicly share recordings.
- Circumvent paywalls or download content you do not have a right to access.
- Scrape content at scale or in ways that violate a site's Terms of Service.

Respect the copyright of lecturers, institutions, and other rights holders.
Downloaded files are for your own, private, educational use. When in doubt,
ask your instructor whether it's okay to keep a local copy.

The authors provide this tool as-is and take no responsibility for how it is
used. See `LICENSE`.

## Features

- Detects MP4 URLs from network traffic (`chrome.webRequest`) and from
  `<video>` / `<source>` elements in the DOM (via a content script that also
  watches for late-loaded players).
- Chrome side panel UI with a per-tab list of streams, each showing filename
  and human-readable size.
- **Copy URL**, **Open**, and **Download** actions for each stream.
- Downloads are auto-named from the active tab's page title, sanitized for
  Windows-safe filenames (strips reserved characters, collapses whitespace,
  caps length, avoids reserved device names).
- Handles Referer-protected CDNs (such as Zoom's replay host) by installing a
  per-click `declarativeNetRequest` session rule that rewrites the `Referer`
  header to match the active tab's origin, and injects CORS response headers
  so a page-context fallback can read the body.
- Automatic fallback for downloads that still get `SERVER_FORBIDDEN`: runs
  `fetch(url, { credentials: "include" })` inside the source tab via
  `chrome.scripting.executeScript`, turns the response into a blob, and
  triggers an `<a download>` click with the page-title filename.
- Surfaces the exact `chrome.downloads.InterruptReason` in a toast when a
  download fails, so you know whether it was a filename issue, a network
  error, or a server rejection.

## Install (unpacked)

1. Clone or download this repo.
2. Open `chrome://extensions` in Chrome.
3. Toggle **Developer mode** on (top right).
4. Click **Load unpacked** and select the `streamloader` directory.
5. The extension action (toolbar icon) opens a side panel when clicked.

No icons are shipped, so Chrome uses its default puzzle-piece icon. Drop PNGs
into an `icons/` directory and re-add the `icons` / `default_icon` keys to
`manifest.json` if you want branding.

## Usage

1. Open the page that plays the video.
2. Start playback so the MP4 URL shows up in network traffic (or is attached
   to a `<video>` element).
3. Click the StreamLoader toolbar icon — the side panel opens and shows the
   detected streams for the active tab.
4. Click **Download** on the stream you want. The file saves to your
   Downloads folder with a name based on the page title.

**Keep the source tab active when you click Download.** The extension reads
the active tab's URL to set the `Referer` header for Referer-protected CDNs.
If you switch to another tab first, the override uses the wrong origin.

### Buttons

- **Copy URL** — copies the raw stream URL to the clipboard.
- **Open** — opens the URL in a new tab with the Referer override applied, so
  Referer-protected URLs (e.g. Zoom replay) will actually load.
- **Download** — saves to disk with the page-title filename. On
  `SERVER_FORBIDDEN`, automatically retries via an in-tab `fetch` so cookies
  and the real Referer come from the source page.

## Known limitations

- **Only plain `.mp4` URLs.** HLS (`.m3u8`) and DASH (`.mpd`) segmented
  streams are not reassembled. For those, use a tool like `yt-dlp`.
- **Page-context fallback buffers the whole file into tab memory.** For
  multi-GB recordings this can be slow or crash the tab. If that happens,
  there's no automatic recovery — use `yt-dlp` or a native downloader.
- **Chrome's built-in video player Download button does not use this
  extension.** When you open a direct MP4 URL in a tab, Chrome's own video
  controls offer a Download icon that saves using a URL-derived filename; for
  signed URLs that filename blows past Windows' `MAX_PATH` and fails. Always
  download from the StreamLoader side panel instead.
- **Referer rewrite is per-click.** The DNR session rule is updated each time
  you click Download or Open; older in-flight requests to the same URL will
  not be rewritten retroactively.

## Project layout

```
streamloader/
  manifest.json       MV3 manifest; side panel + DNR + downloads
  background.js       Service worker: webRequest capture, DNR rules, messaging
  content.js          DOM scanner for <video>/<source> elements
  sidepanel.html      Side panel markup
  sidepanel.css       Side panel styles (light + dark)
  sidepanel.js        Side panel logic, download flow, fallback
  README.md
  LICENSE
```

## Tech notes

- Manifest V3, service worker background (no persistent page).
- Permissions: `webRequest`, `storage`, `tabs`, `activeTab`, `scripting`,
  `downloads`, `webNavigation`, `sidePanel`,
  `declarativeNetRequestWithHostAccess`. Host permissions: `<all_urls>`.
- Stream capture uses `chrome.webRequest.onBeforeRequest` +
  `onHeadersReceived` for network detection, and a mutation-observer-based
  content script for DOM detection.
- Referer override uses `chrome.declarativeNetRequest.updateSessionRules` with
  a per-download rule (id `2001`) that rewrites the `Referer` request header
  and injects `Access-Control-Allow-Origin` / `Access-Control-Allow-Credentials`
  response headers so a cross-origin page-context fetch can read the body.
- Download fallback runs a `chrome.scripting.executeScript` call targeting
  the source tab, where the injected function does the `fetch` and triggers
  a blob-URL download.

## Contributing

Bug reports and PRs welcome. Please keep the tool focused on its intended
use case (personal study copies of authorized content). Feature requests for
scraping, bulk downloading, or DRM circumvention will be closed.

## License

MIT — see `LICENSE`.
