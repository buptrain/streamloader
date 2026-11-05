# StreamLoader

**A focused local-study tool for saving authorized MP4 recordings.**

StreamLoader is a Chrome side-panel extension that discovers plain MP4 streams playing in the current tab, gives each one a useful page-title filename, and lets the viewer copy, open, or download it. It is built for people who are permitted to retain their own course recordings, event replays, or other media for offline use.

Use it only for content you are authorized to access and keep. StreamLoader does not bypass DRM, paywalls, or access controls.

---

## The workflow

1. Open a page containing an authorized MP4 recording and start playback.
2. StreamLoader detects eligible MP4 URLs from the network and the page's video elements.
3. Open the side panel to review the streams found for that tab.
4. Copy the URL, open it, or download it with a filename derived from the page title.

Detection and per-tab state remain in the browser. The extension does not use an account or backend service.

## What it does

- Detects direct `.mp4` resources from Chrome network events and `<video>` / `<source>` elements, including players added after page load.
- Keeps a separate stream list for each browser tab, with a toolbar badge showing the detected count.
- Offers **Copy URL**, **Open**, and **Download** actions.
- Sanitizes page titles for Windows-safe filenames and avoids reserved device names.
- Captures content type and file size when those response headers are available.
- Can generate an on-demand first-frame thumbnail and resolution badge; both degrade gracefully when the source cannot be read cross-origin.
- Handles some referer- and cookie-protected authorized sources by applying a short-lived, per-click request rule and retrying in the source tab when Chrome's download manager is rejected.

## Architecture

```text
current browser tab
  ├─ network events ───────┐
  └─ DOM video scanner ────┤
                           ↓
                service-worker stream registry
                           ↓
                      side-panel UI
                           ↓
            copy / open / authorized download
```

- `background.js` is the Manifest V3 service worker. It collects streams, manages per-tab state, and configures short-lived declarative network rules for an action.
- `content.js` watches the document for video and source elements, complementing network-based detection.
- `sidepanel.js` presents the detected stream list, filename handling, download flow, metadata probes, and optional thumbnail queue.
- `sidepanel.html` and `sidepanel.css` define the local side-panel interface.

## Permissions, explained

StreamLoader needs broad browser permissions because it observes media requests and operates on the active source page.

| Permission | Why it is used |
| --- | --- |
| `webRequest` | Detect eligible MP4 requests and read available response metadata |
| `tabs`, `activeTab`, `webNavigation` | Keep results scoped to the active tab and clear them on navigation |
| `sidePanel` | Present the stream list |
| `downloads` | Start a user-requested download |
| `scripting` | Retry an authorized download in the source-page context when needed |
| `declarativeNetRequestWithHostAccess` and host access | Apply a short-lived referer/CORS rule for the selected source |
| `storage` | Reserved by the current extension configuration |

The extension only targets plain MP4 URLs. It does not reconstruct HLS (`.m3u8`) or DASH (`.mpd`) streams, and it does not decrypt or circumvent DRM.

## Install locally

This repository has no build step.

1. Clone or download this repository.
2. In Chrome, open `chrome://extensions`.
3. Enable **Developer mode**.
4. Select **Load unpacked** and choose this repository's root folder.
5. Click the StreamLoader toolbar icon to open its side panel.

## Use responsibly

1. Navigate to media you are allowed to retain and start playback.
2. Open StreamLoader from the Chrome toolbar.
3. Review the list for the current tab; refresh or clear it as needed.
4. Select **Download** to save a local copy, or **Copy URL** / **Open** for the selected stream.

Keep the source tab active when choosing **Download**. The extension uses that tab's origin for the temporary referer override needed by some authorized CDNs.

## Known limits

- Only direct, non-segmented MP4 URLs are supported.
- A signed URL, a source that requires an unavailable cookie, or a CDN that rejects cross-origin media can prevent metadata, thumbnail, or download operations.
- The fallback path buffers the entire file in the source tab; very large files can be slow or exhaust tab memory.
- Temporary request rules are configured per action. They are not a general-purpose download manager.
- The tool is loaded unpacked and is not distributed through the Chrome Web Store.

## Repository map

```text
manifest.json       Chrome Manifest V3 configuration
background.js       Stream registry, request rules, and service-worker messaging
content.js          DOM video/source discovery
sidepanel.html      Side-panel markup
sidepanel.css       Side-panel styling
sidepanel.js        User actions, metadata, thumbnails, and download flow
LICENSE             MIT license
```

## Screenshots

The repository currently has no product screenshots. If you add screenshots, use only authorized media and remove account names, URLs, course titles, and other identifying data.

## License

[MIT](LICENSE)
