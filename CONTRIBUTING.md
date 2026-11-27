# Contributing

Thanks for helping out. This extension is small on purpose: no dependencies, no build
framework, no remote code.

## Getting started

```bash
git clone https://github.com/mrchatam/telegram-media-downloader.git
cd telegram-media-downloader
npm run verify   # check + tests + build
```

Node.js 20 or newer is required. There is nothing to `npm install`; if `npm install` created a
lockfile it is fine to commit it, but the project needs no packages.

Load `dist/` from `chrome://extensions` → **Load unpacked**. After editing files under `src/`,
click the reload icon on the extension card and reload the Telegram tab. Service worker logs
are under the extension's **service worker** link; page and content script logs are in the
normal DevTools console.

## Reporting bugs

Use the [issue templates](https://github.com/mrchatam/telegram-media-downloader/issues/new/choose).
A useful report includes:

- Chrome version and operating system
- whether you use Web A (`/a`) or Web K (`/k`)
- what you expected, what happened, and which button was involved
- console errors from the Telegram tab, filtered by `TMD` where possible

## Fixing broken selectors

Telegram Web ships new builds regularly and DOM class names change. That is the most common
kind of breakage.

1. Find the failing element in DevTools, note the stable attributes (`data-mid`,
   `data-message-id`, classes).
2. Update the selector in `classifyWrapperA` / `classifyWrapperK` / `injectSharedMedia*` in
   `src/content.js`, preferring the most specific stable selector available.
3. Verify against a real chat in both clients where possible.

Please keep selectors defensive: never throw inside the scan loop, and keep the extension
working if an element is missing.

## Pull requests

- Keep the change focused; one concern per pull request.
- Run `npm run verify` before pushing. CI runs the same command.
- Add or update a test in `tests/` when you touch the helpers in `src/page-downloader.js`
  (`parseContentRange`, `resolveDownloadFilename`, `hlsToStreamUrl`,
  `findHlsStreamUrlFromEntries`, …). Those helpers are exported for Node when `module` exists.
- Update `CHANGELOG.md` under **Unreleased** for user-visible changes.
- If you change the version, use `npm version <patch|minor|major> --no-git-tag-version` and
  then `npm run version:sync`.

## Code style

Plain ES2022 JavaScript, no TypeScript, no bundler. Match the surrounding code: double quotes,
2-space indentation, semicolons, early returns. Content scripts are wrapped in an IIFE and
must not leak globals onto the page.

## Scope

Out of scope for this project: telemetry, remote configuration, accounts, server components,
non-Telegram sites, and downloading content the user is not allowed to save. See the
disclaimer in the [README](README.md#disclaimer).
