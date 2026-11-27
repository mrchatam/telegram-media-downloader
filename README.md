<p align="center">
  <img src="assets/icon.svg" width="96" height="96" alt="Telegram Media Downloader icon">
</p>

<h1 align="center">Telegram Media Downloader</h1>

<p align="center">
  Unlimited downloads for videos, photos, voice messages and files on Telegram Web.<br>
  No accounts, no quotas, no telemetry — one small Manifest V3 extension.
</p>

<p align="center">
  <a href="https://github.com/mrchatam/telegram-media-downloader/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/mrchatam/telegram-media-downloader/actions/workflows/ci.yml/badge.svg"></a>
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-c026d3.svg"></a>
  <a href="https://github.com/mrchatam/telegram-media-downloader/releases/latest"><img alt="Latest release" src="https://img.shields.io/github/v/release/mrchatam/telegram-media-downloader?display_name=tag"></a>
  <img alt="Manifest V3" src="https://img.shields.io/badge/manifest-v3-4285f4.svg">
</p>

---

Telegram Web only lets you save media one item at a time, and it slows you down after a
handful of files. This extension adds download buttons directly to the chat UI and runs its
own transfer queue, so you can grab a single video, a whole album or every file in the shared
media panel without hitting a daily limit.

It talks only to `web.telegram.org` with the session you are already signed in to.

## Features

| Feature | What it does |
| --- | --- |
| **Inline download buttons** | A Download button under every video, photo, audio and voice message in chats |
| **Album selection** | Per-item checkboxes on albums, plus a single "Download Selected" action |
| **Media viewer button** | Download from the full-screen viewer without closing and reopening it |
| **Shared media panel** | One button per item and "Download All Shared Media" for the whole tab |
| **No daily limit** | Own queue with 3 parallel transfers, so the page stays responsive |
| **Live progress and cancel** | Percentage on the button, per-download cancel, aggregate badge counter |
| **Popup dashboard** | Active/completed transfers, sizes, and "Download All Loaded Media" |
| **Web A and Web K** | Works on both `web.telegram.org/a` and `web.telegram.org/k` |

Supported media: MP4/WebM/MOV/MKV video, JPEG/PNG/WebP/GIF images, and OGG/OPUS/MP3/M4A/AAC
audio. Streamed videos are resolved to Telegram's progressive stream URL, so quality is not
re-encoded or lost.

## Install

The extension is not on the Chrome Web Store yet, so you install it from source or from a
release archive. It takes about a minute.

### Option 1 — Release archive (easiest)

1. Download the latest `telegram-media-downloader-<version>.zip` from
   [Releases](https://github.com/mrchatam/telegram-media-downloader/releases/latest).
2. Unzip it into a folder you intend to keep (the extension is loaded from that folder, so
   don't delete it). It works fine after unzipping — no build step.
3. Open `chrome://extensions`.
4. Turn on **Developer mode** (top right).
5. Click **Load unpacked** and select the unzipped folder (the one containing `manifest.json`).
6. Open <https://web.telegram.org> and reload the tab once.

### Option 2 — Clone and build

```bash
git clone https://github.com/mrchatam/telegram-media-downloader.git
cd telegram-media-downloader
npm run build          # writes dist/ and dist/telegram-media-downloader-<version>.zip
```

Then load `dist/` with **Load unpacked**. Requires Node.js 20 or newer; the build has no
dependencies to install.

### Other Chromium browsers

Microsoft Edge (`edge://extensions`), Brave (`brave://extensions`), Vivaldi, Opera and other
Chromium-based browsers accept the same folder through their own "Load unpacked" flow.
Firefox is **not** supported: the extension relies on Manifest V3 service workers and
`MAIN`-world content scripts.

## Verify it yourself

Installing an extension means trusting a stranger's code. This one is small enough to check in
a few minutes, and every release ships a checksum you can compare.

**1. Read the code.** No bundler, no minification, no dependencies, no remote code: four plain
scripts plus two stylesheets.

| File | Lines | Role |
| --- | --- | --- |
| `src/content.js` | 1,275 | Finds media elements, injects the buttons |
| `src/page-downloader.js` | 473 | Fetches the file, reports progress, saves it |
| `src/popup.js` | 139 | Renders the toolbar popup |
| `src/background.js` | 86 | Transfer list, badge count, cancel routing |

**2. Check the network surface.** There are exactly two `fetch` calls, both in
`page-downloader.js`, and no `XMLHttpRequest`, `WebSocket` or `sendBeacon` anywhere:

```bash
grep -rn "fetch(\|XMLHttpRequest\|sendBeacon\|new WebSocket" src/
```

Both fetch the media URL the Telegram tab already requested, so the extension adds no endpoints,
analytics hosts or third-party servers of its own. The only hard-coded URL in the project is
`https://web.telegram.org/`, used in `popup.js` to check whether the active tab is Telegram Web.

**3. Check the permissions.** `manifest.json` requests one host (`https://web.telegram.org/*`)
and no API permissions at all.

**4. Verify the download.** Each release attaches a `SHA256SUMS` file:

```bash
# save the .zip and SHA256SUMS in the same folder, then
sha256sum -c SHA256SUMS            # macOS: shasum -a 256 -c SHA256SUMS
```

Expect `telegram-media-downloader-<version>.zip: OK`.

**5. Rebuild and compare.** Builds are deterministic — fixed archive timestamps, sorted entries
— so the published archive can be reproduced from the tag:

```bash
git checkout v1.0.1
npm run build
sha256sum dist/telegram-media-downloader-1.0.1.zip   # macOS: shasum -a 256 ...
```

On the same Node.js major version this prints the same hash as the release. A different Node or
zlib build can compress differently; if your hash differs, compare contents instead — `unzip -l`
and `unzip -p <zip> manifest.json` should match this repository at that tag.

## Usage

1. Sign in at <https://web.telegram.org> (either the A or K client).
2. Open any chat. Each media message now has a **Download** button below it.
3. Click it. The button shows progress, then returns to its idle label when the file is saved.
4. Click the ✕ on a running transfer (or in the popup) to cancel it.
5. Click the toolbar icon for the popup: live transfer list, **Download All Loaded Media** for
   everything currently rendered in the chat, and **Clear done**.

Notes:

- Large videos download at network speed; a progress percentage appears once the size is known.
- Files are saved by the browser through their normal download flow, so you get the usual
  download shelf and history entry.
- If Telegram Web changes its markup, buttons may stop appearing until the selectors are
  updated — see [Contributing](#contributing).

## FAQ

### Will using this get my Telegram account banned?

No extension can promise that, so here is what it does and does not do. It does not log in
separately, does not implement the Telegram API, and never sees your credentials: it reuses the
session in your own signed-in tab, reading media URLs that tab has already fetched. It issues
ordinary media `GET` requests from the page instead of driving Telegram's download button, at a
pace it self-limits to 3 concurrent transfers. To Telegram, that traffic looks like the browser
it already is. As with any client-side tooling, heavy or automated use is your own call — see
the [disclaimer](#disclaimer).

### Is this against Telegram's Terms of Service?

This project is unofficial and not endorsed by Telegram. Telegram's
[Terms of Service](https://telegram.org/tos) restrict scraping and unauthorised automation, and
you are bound by them as an account holder. Saving media from your own conversations is normally
fine; redistributing copyrighted material is not. If your intended use would break the ToS or
someone's copyright, don't use this — that decision and its consequences are yours, not the
maintainers'.

### Why does Chrome warn about developer-mode extensions?

Because it warns about anything not installed from the Web Store: on startup Chrome shows a
"Disable developer mode extensions" bubble for extensions loaded from a folder. It is generic —
Chrome cannot verify the publisher or deliver updates for an unpacked folder — and it is not a
finding about this code. You can dismiss it each time, or install from a store listing once one
exists, which removes the warning. Unpacked extensions also never auto-update; see below.

### Can it read my messages?

It can see the page — every content script can — and it must inspect the DOM to locate media
elements and message IDs. What it does not do: parse or collect message text, store anything
(`chrome.storage` is never used), or transmit page content anywhere. There is no telemetry and no
request to any host other than the media URL your own tab is using. The injected page script talks
only to this extension's content script via `window.postMessage`. That whole path is the ~2,000
lines listed above.

### How do I update it?

Unpacked extensions never update themselves.

- **Release-zip install:** download the new archive, replace the contents of your folder (keep the
  same path), then click the reload icon for the extension on `chrome://extensions`.
- **Cloned repository:** `git pull && npm run build`, copy the new `dist/` over the loaded folder,
  reload.
- **Store install:** automatic, once a listing exists.

Your saved files are untouched by any of this; only the popup's in-memory transfer list resets.

## Permissions

| Permission | Why |
| --- | --- |
| Host access to `https://web.telegram.org/*` | Inject the download buttons and read media URLs on Telegram Web only |

No `downloads`, `storage`, `tabs`, `cookies` or `<all_urls>` access is requested. The extension
has no background server, no analytics, no external network calls beyond the Telegram origin
your tab is already using, and no remote code. See [PRIVACY.md](PRIVACY.md).

## How it works

```
┌──────────────────────── web.telegram.org tab ────────────────────────┐
│                                                                     │
│  page-downloader.js  (MAIN world, page context)                     │
│    • resolves progressive stream URLs / HLS manifests / blobs        │
│    • fetch queue, 3 at a time, with Range support and cancel         │
│    • reports progress via window.postMessage                        │
│                          ▲  │                                       │
│              postMessage │  ▼  postMessage                          │
│  content.js  (isolated world)                                       │
│    • scans the DOM, injects buttons, renders progress                │
│    • bridges the page and the extension runtime                      │
└──────────────────────────────────┬──────────────────────────────────┘
                                   │ chrome.runtime messages
                     background.js (service worker)
                       • transfer state, badge count, cancel routing
                     popup.html / popup.js
                       • transfer list and batch trigger
```

| File | Role |
| --- | --- |
| `src/page-downloader.js` | Page-context engine: URL resolution, fetching, progress, saving |
| `src/content.js` | Chat UI integration for Web A and Web K |
| `src/content.css` | Injected button and checkbox styles |
| `src/background.js` | Service worker: state, badge, message routing |
| `src/popup.{html,css,js}` | Toolbar popup |
| `icons/`, `assets/icon.svg` | Extension icons and source artwork |

## Development

```bash
npm test              # unit tests (node:test) for URL/filename/HLS helpers
npm run check         # manifest validation + syntax check of every source file
npm run build         # check, then emit dist/ and the release zip
npm run verify        # check + test + build — what CI runs
npm run version:sync  # copy package.json version into manifest.json
```

There are no runtime or dev dependencies. After changing source files, click the reload icon
for the extension on `chrome://extensions` and reload the Telegram tab.

### Releasing

Releases are automated; the version lives in two places that CI keeps in sync.

```bash
# 1. bump the version and sync the manifest
npm version minor --no-git-tag-version
npm run version:sync

# 2. describe the change
#    move the Unreleased section of CHANGELOG.md into a new version heading

# 3. commit, tag and push — the release workflow builds and publishes the zip
git commit -am "release: v$(node -p "require('./package.json').version")"
git tag -a "v$(node -p "require('./package.json').version")" -m "v$(node -p "require('./package.json').version")"
git push --follow-tags
```

Use an **annotated** tag (`-a`): `git push --follow-tags` ignores lightweight tags, so a
`git tag v1.0.1` would be left behind and no release would be created.

`.github/workflows/release.yml` then runs the checks, builds the archive, attaches it to a
GitHub Release and uses the matching `CHANGELOG.md` section as release notes.

## Project structure

```
.
├── .github/workflows/    CI and release automation
├── assets/icon.svg       Source artwork
├── icons/               16/48/128 px PNG icons
├── scripts/              check.mjs, build.mjs (build + zip, zero dependencies)
├── src/                  Extension source
├── tests/                node:test unit tests
├── manifest.json         Manifest V3 definition
└── package.json          Scripts, version, metadata
```

## Disclaimer

This is an unofficial, community project. It is not affiliated with, endorsed by or sponsored
by Telegram Messenger. Only download content you own or have permission to save, and respect
[Telegram's Terms of Service](https://telegram.org/tos) and the copyright of others. The
authors take no responsibility for how the software is used.

## Contributing

Bug reports, selector fixes for new Telegram Web builds and pull requests are welcome — see
[CONTRIBUTING.md](CONTRIBUTING.md). For security issues, please follow [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE) © mrchatam
