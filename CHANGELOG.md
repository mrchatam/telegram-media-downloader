# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Copy button on messages with text, including channels where the page blocks selecting and
  copying. Text is read from the DOM and written with the async Clipboard API, with an
  `execCommand` fallback. Quoted replies, forward headers, sender names, timestamps and the
  extension's own controls are excluded; media captions copy with the message.

## [1.0.1] - 2026-11-27

### Removed

- `homepage_url` from the manifest; it pointed back at this repository and duplicated the
  support links already shown on the extension card.

## [1.0.0] - 2026-11-27

### Added

- Inline download buttons for videos, photos, audio and voice messages on Telegram Web A and
  Web K.
- Album downloads with per-item checkboxes and a "Download Selected" action.
- Download button inside the media viewer and per-item buttons in the shared media panel,
  including "Download All Shared Media".
- Own transfer queue with 3 concurrent downloads, live progress, per-download cancel and a
  badge counter, so Telegram Web's quota is not involved.
- Toolbar popup with active and completed transfers, file sizes, "Download All Loaded Media"
  and "Clear done".
- Progressive stream and HLS resolution so full-quality video is saved without re-encoding.
- Occasional fallback to Telegram Web's own download button when a stream cannot be resolved.
- Unit tests for URL parsing, filename resolution and HLS helpers.
- Zero-dependency build that produces an unpacked folder and a distributable zip archive.
- GitHub Actions CI and automated release workflow.

[Unreleased]: https://github.com/mrchatam/telegram-media-downloader/compare/v1.0.1...HEAD
[1.0.1]: https://github.com/mrchatam/telegram-media-downloader/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/mrchatam/telegram-media-downloader/releases/tag/v1.0.0
