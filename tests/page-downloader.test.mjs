import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const utils = require("../src/page-downloader.js");

test("parseContentRange parses valid range and wildcard", () => {
  assert.deepEqual(utils.parseContentRange("bytes 0-1023/4096"), {
    start: 0,
    end: 1023,
    total: 4096
  });
  assert.deepEqual(utils.parseContentRange("bytes 1024-2047/*"), {
    start: 1024,
    end: 2047,
    total: null
  });
  assert.equal(utils.parseContentRange("invalid"), null);
});

test("parseStreamMetadata extracts filename and location id", () => {
  const payload = encodeURIComponent(
    JSON.stringify({ fileName: "demo.clip.mp4", location: { id: "12345" } })
  );
  const meta = utils.parseStreamMetadata(`https://web.telegram.org/k/stream/${payload}?x=1`);
  assert.equal(meta.fileName, "demo.clip.mp4");
  assert.equal(meta.location.id, "12345");
});

test("resolveDownloadFilename preserves multi-dot names and falls back cleanly", () => {
  const streamUrl = `https://web.telegram.org/k/stream/${encodeURIComponent(
    JSON.stringify({ fileName: "my.video.2026.mp4" })
  )}`;
  assert.equal(
    utils.resolveDownloadFilename(streamUrl, { mediaType: "video", contentType: "video/mp4" }),
    "my.video.2026.mp4"
  );

  assert.equal(
    utils.resolveDownloadFilename("https://web.telegram.org/a/progressive/document998877", {
      mediaType: "video",
      contentType: "video/mp4"
    }),
    "tg_document998877.mp4"
  );

  assert.equal(
    utils.resolveDownloadFilename("blob:https://web.telegram.org/abc-123", {
      mediaType: "image",
      contentType: "image/jpeg",
      itemId: "42"
    }),
    "tg_image_42.jpg"
  );
});

test("hlsToStreamUrl converts hls video URLs and skips quality manifests", () => {
  assert.equal(
    utils.hlsToStreamUrl("https://web.telegram.org/k/hls/12345"),
    "https://web.telegram.org/k/stream/12345"
  );
  assert.equal(
    utils.hlsToStreamUrl("https://web.telegram.org/k/hls/hls_quality_file_720"),
    null
  );
  assert.equal(utils.hlsToStreamUrl("https://web.telegram.org/k/stream/12345"), null);
});

test("findHlsStreamUrlFromEntries prefers entries after sinceIndex and supports fallback", () => {
  const entries = [
    { name: "https://web.telegram.org/k/hls/old_video" },
    { name: "https://web.telegram.org/k/hls/hls_quality_file_1" },
    { name: "https://web.telegram.org/k/hls/new_video" }
  ];
  assert.equal(
    utils.findHlsStreamUrlFromEntries(entries, 1, false),
    "https://web.telegram.org/k/stream/new_video"
  );
  assert.equal(utils.findHlsStreamUrlFromEntries(entries.slice(0, 2), 1, false), null);
  assert.equal(
    utils.findHlsStreamUrlFromEntries(entries.slice(0, 2), 1, true),
    "https://web.telegram.org/k/stream/old_video"
  );
});
