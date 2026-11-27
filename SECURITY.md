# Security Policy

## Supported versions

Fixes land on the `main` branch and in the newest release. Older releases are not patched;
please update instead.

## Reporting a vulnerability

Do **not** open a public issue for security problems. Instead use GitHub's private reporting:

<https://github.com/mrchatam/telegram-media-downloader/security/advisories/new>

Please include affected version, browser, reproduction steps and any proof-of-concept. Expect
an initial reply within a few days. Once a fix is available it will be released together with
an advisory crediting the reporter, unless you prefer to stay anonymous.

## Scope notes

Useful things to look for:

- code that would let a web page spoof or hijack the extension's `postMessage` bridge
- downloads that could be redirected to a non-Telegram origin
- filename handling that could write outside the download folder or escape sanitisation
- anything that would exfiltrate data or load remote code

The extension runs no server and stores no data, so there is no hosted service to test.
