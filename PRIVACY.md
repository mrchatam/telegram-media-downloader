# Privacy Policy

**Telegram Media Downloader does not collect, transmit or sell any data.**

- **No analytics, telemetry or crash reporting.** The extension contains no tracking code and
  no third-party scripts.
- **No remote servers.** Everything runs locally in your browser. The extension never contacts
  a server of its own and never loads remote code.
- **No accounts.** There is no sign-in, no identifier and no licence check.
- **No stored history.** The transfer list exists only in the extension's service worker memory
  for the current browser session. It is discarded when the service worker is unloaded or the
  browser restarts; nothing is written to `chrome.storage`, cookies or disk by the extension.
- **No page data collection.** The content script reads the Telegram Web page only to place
  download buttons and to work out which media file you asked for. That information is used
  in-memory and never leaves your device.
- **Network access is limited to Telegram.** Files are fetched from the same `web.telegram.org`
  origin your signed-in tab is already using. The only host permission requested is
  `https://web.telegram.org/*`.

Files you download are handled by your browser's normal download manager and saved to your
computer, exactly as if you had used Telegram's own download button.

## Changes

Any change to this policy will be committed to this repository, so the history is public.

## Contact

Open an issue at <https://github.com/mrchatam/telegram-media-downloader/issues>.

_Last updated: 2026-11-27_
