(() => {
  "use strict";

  const MSG_SOURCE = "tmd-extension";
  const DEFAULT_CONCURRENCY = 3;
  const REQUEST_TIMEOUT_MS = 60_000;

  const MIME_EXTENSIONS = {
    "video/mp4": "mp4",
    "video/webm": "webm",
    "video/quicktime": "mov",
    "video/x-matroska": "mkv",
    "image/jpeg": "jpg",
    "image/jpg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "image/gif": "gif",
    "audio/ogg": "ogg",
    "audio/opus": "opus",
    "audio/mpeg": "mp3",
    "audio/mp3": "mp3",
    "audio/mp4": "m4a",
    "audio/aac": "aac",
    "audio/wav": "wav",
    "audio/flac": "flac"
  };

  function parseContentRange(headerValue) {
    if (!headerValue || typeof headerValue !== "string") return null;
    const match = headerValue.match(/^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i);
    if (!match) return null;
    const start = Number.parseInt(match[1], 10);
    const end = Number.parseInt(match[2], 10);
    const total = match[3] === "*" ? null : Number.parseInt(match[3], 10);
    if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
    return { start, end, total };
  }

  function inferExtensionFromMime(contentType, mediaType) {
    if (contentType && typeof contentType === "string") {
      const normalized = contentType.split(";")[0].trim().toLowerCase();
      if (MIME_EXTENSIONS[normalized]) {
        return MIME_EXTENSIONS[normalized];
      }
      const slash = normalized.indexOf("/");
      if (slash > -1) {
        const sub = normalized.slice(slash + 1).replace(/[^a-z0-9]/gi, "");
        if (sub && sub !== "octetstream") {
          return sub === "jpeg" ? "jpg" : sub;
        }
      }
    }
    if (mediaType === "image") return "jpg";
    if (mediaType === "audio") return "ogg";
    return "mp4";
  }

  function sanitizeFilename(name) {
    if (!name || typeof name !== "string") return "telegram-media";
    return name
      .replace(/[\\/:*?"<>|\x00-\x1f]/g, "_")
      .replace(/\s+/g, " ")
      .trim() || "telegram-media";
  }

  function applyExtension(filename, ext) {
    const clean = sanitizeFilename(filename);
    if (!ext) return clean;
    const lastDot = clean.lastIndexOf(".");
    if (lastDot > 0 && lastDot < clean.length - 1) {
      const existingExt = clean.slice(lastDot + 1).toLowerCase();
      if (/^[a-z0-9]{2,5}$/.test(existingExt)) {
        return clean;
      }
    }
    return `${clean}.${ext}`;
  }

  function parseStreamMetadata(url) {
    if (!url || typeof url !== "string") return null;
    const idx = url.indexOf("stream/");
    if (idx === -1) return null;
    try {
      const encoded = url.slice(idx + "stream/".length).split("?")[0].split("#")[0];
      const parsed = JSON.parse(decodeURIComponent(encoded));
      if (parsed && typeof parsed === "object") {
        return parsed;
      }
    } catch {
      return null;
    }
    return null;
  }

  function extractProgressiveFilename(url) {
    if (!url || typeof url !== "string") return "";
    const idx = url.indexOf("progressive/");
    if (idx === -1) return "";
    const tail = url.slice(idx + "progressive/".length).split("?")[0].split("#")[0];
    const docMatch = tail.match(/(document\d+|photo\d+|video\d+|audio\d+)/i);
    if (docMatch) return `tg_${docMatch[1]}`;
    const safeTail = tail.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 48);
    return safeTail ? `tg_${safeTail}` : "";
  }

  function resolveDownloadFilename(url, { mediaType, contentType, itemId, suggestedName } = {}) {
    const ext = inferExtensionFromMime(contentType, mediaType);
    if (suggestedName) {
      return applyExtension(suggestedName, ext);
    }
    const streamMeta = parseStreamMetadata(url);
    if (streamMeta?.fileName) {
      return applyExtension(streamMeta.fileName, ext);
    }
    if (streamMeta?.location?.id) {
      return applyExtension(`tg_${streamMeta.location.id}`, ext);
    }
    const progName = extractProgressiveFilename(url);
    if (progName) {
      return applyExtension(progName, ext);
    }
    if (itemId) {
      return applyExtension(`tg_${mediaType || "media"}_${itemId}`, ext);
    }
    if (url && url.startsWith("blob:")) {
      const tail = url.split("/").pop()?.split("?")[0] || Date.now().toString(36);
      return applyExtension(`tg_${mediaType || "media"}_${tail}`, ext);
    }
    return applyExtension(`tg_${mediaType || "media"}_${Date.now().toString(36)}`, ext);
  }

  function hlsToStreamUrl(resourceUrl) {
    if (!resourceUrl || typeof resourceUrl !== "string") return null;
    if (!resourceUrl.includes("hls/") || resourceUrl.includes("hls_quality_file")) {
      return null;
    }
    return resourceUrl.replace("hls/", "stream/");
  }

  function findHlsStreamUrlFromEntries(entries, sinceIndex = 0, allowFallback = false) {
    if (!Array.isArray(entries) || entries.length === 0) return null;
    const start = Math.max(0, Math.min(sinceIndex, entries.length));
    for (let i = entries.length - 1; i >= start; i--) {
      const converted = hlsToStreamUrl(entries[i]?.name);
      if (converted) return converted;
    }
    if (allowFallback) {
      for (let i = start - 1; i >= 0; i--) {
        const converted = hlsToStreamUrl(entries[i]?.name);
        if (converted) return converted;
      }
    }
    return null;
  }

  // Expose pure helpers for Node unit tests
  if (typeof module !== "undefined" && module.exports) {
    module.exports = {
      parseContentRange,
      inferExtensionFromMime,
      sanitizeFilename,
      applyExtension,
      parseStreamMetadata,
      extractProgressiveFilename,
      resolveDownloadFilename,
      hlsToStreamUrl,
      findHlsStreamUrlFromEntries
    };
    return;
  }

  if (typeof window === "undefined" || window.__tmdPageDownloaderLoaded) {
    return;
  }
  window.__tmdPageDownloaderLoaded = true;

  const activeDownloads = new Map(); // downloadId -> { controller, cancelled }
  const pendingQueue = [];
  let runningCount = 0;

  function emit(type, payload) {
    window.postMessage({ source: MSG_SOURCE, direction: "page-to-ext", type, ...payload }, "*");
  }

  async function fetchWithTimeout(url, options = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort(new DOMException("Request timeout", "TimeoutError"));
    }, timeoutMs);

    const externalSignal = options.signal;
    let onAbort = null;
    if (externalSignal) {
      if (externalSignal.aborted) {
        clearTimeout(timer);
        throw new DOMException("Download cancelled", "AbortError");
      }
      onAbort = () => {
        clearTimeout(timer);
        controller.abort(externalSignal.reason || new DOMException("Download cancelled", "AbortError"));
      };
      externalSignal.addEventListener("abort", onAbort, { once: true });
    }

    try {
      return await fetch(url, { ...options, signal: controller.signal });
    } catch (err) {
      if (externalSignal?.aborted) {
        throw new DOMException("Download cancelled", "AbortError");
      }
      throw err;
    } finally {
      clearTimeout(timer);
      if (onAbort && externalSignal) {
        externalSignal.removeEventListener("abort", onAbort);
      }
    }
  }

  function triggerBrowserSave(blob, filename) {
    const objectUrl = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = objectUrl;
    link.download = filename;
    link.style.display = "none";
    document.body.appendChild(link);
    link.click();
    setTimeout(() => {
      link.remove();
      URL.revokeObjectURL(objectUrl);
    }, 1500);
  }

  async function downloadBlobUrl(url, signal, onProgress) {
    const response = await fetchWithTimeout(url, { signal }, REQUEST_TIMEOUT_MS);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} while reading blob`);
    }
    const contentType = response.headers.get("Content-Type") || "";
    const blob = await response.blob();
    onProgress(100, blob.size);
    return { blob, contentType };
  }

  async function downloadStreamWithRange(url, signal, onProgress) {
    const chunks = [];
    let offset = 0;
    let totalSize = null;
    let detectedType = "";

    while (true) {
      if (signal.aborted) {
        throw new DOMException("Download cancelled", "AbortError");
      }

      let response = null;
      let lastErr = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        if (signal.aborted) {
          throw new DOMException("Download cancelled", "AbortError");
        }
        try {
          response = await fetchWithTimeout(
            url,
            {
              method: "GET",
              headers: { Range: `bytes=${offset}-` },
              signal
            },
            REQUEST_TIMEOUT_MS
          );
          if ([200, 206].includes(response.status)) {
            lastErr = null;
            break;
          }
          lastErr = new Error(`Unexpected status ${response.status} for stream`);
        } catch (err) {
          if (err?.name === "AbortError") throw err;
          lastErr = err;
        }
        await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
      }
      if (lastErr || !response) {
        throw lastErr || new Error("Stream request failed");
      }

      const ct = response.headers.get("Content-Type");
      if (ct && !detectedType) {
        detectedType = ct.split(";")[0].trim();
      }

      const contentRange = response.headers.get("Content-Range");
      if (!contentRange) {
        const blob = await response.blob();
        onProgress(100, blob.size);
        return { blob, contentType: detectedType || blob.type };
      }

      const parsed = parseContentRange(contentRange);
      if (!parsed) {
        throw new Error(`Invalid Content-Range header: ${contentRange}`);
      }
      if (parsed.start !== offset) {
        throw new Error(`Range gap: expected offset ${offset}, got ${parsed.start}`);
      }
      if (parsed.total !== null) {
        if (totalSize !== null && parsed.total !== totalSize) {
          throw new Error("Stream total size changed mid-download");
        }
        totalSize = parsed.total;
      }

      const chunkBlob = await response.blob();
      chunks.push(chunkBlob);
      offset = parsed.end + 1;

      if (totalSize && totalSize > 0) {
        const pct = Math.min(100, Math.round((offset / totalSize) * 100));
        onProgress(pct, totalSize);
        if (offset >= totalSize) break;
      } else {
        onProgress(50, offset);
        if (chunkBlob.size === 0) break;
      }
    }

    const mime = detectedType || "application/octet-stream";
    return { blob: new Blob(chunks, { type: mime }), contentType: mime };
  }

  async function executeDownload(task) {
    const { downloadId, url, mediaType, itemId, suggestedName } = task;
    const entry = activeDownloads.get(downloadId);
    if (!entry || entry.cancelled) return;

    const { signal } = entry.controller;
    const onProgress = (progress, sizeBytes) => {
      emit("progress", { downloadId, itemId, progress, sizeBytes });
    };

    try {
      emit("progress", { downloadId, itemId, progress: 1 });

      let result;
      if (url.startsWith("blob:")) {
        result = await downloadBlobUrl(url, signal, onProgress);
      } else {
        result = await downloadStreamWithRange(url, signal, onProgress);
      }

      if (signal.aborted) {
        throw new DOMException("Download cancelled", "AbortError");
      }

      const filename = resolveDownloadFilename(url, {
        mediaType,
        contentType: result.contentType,
        itemId,
        suggestedName
      });

      const finalMime =
        (result.contentType && result.contentType.split(";")[0].trim()) ||
        result.blob.type ||
        "application/octet-stream";
      const finalBlob =
        result.blob.type === finalMime
          ? result.blob
          : new Blob([result.blob], { type: finalMime });

      triggerBrowserSave(finalBlob, filename);
      emit("done", {
        downloadId,
        itemId,
        filename,
        sizeBytes: finalBlob.size
      });
    } catch (err) {
      if (err?.name === "AbortError" || entry.cancelled) {
        emit("canceled", { downloadId, itemId });
      } else {
        emit("error", {
          downloadId,
          itemId,
          error: err?.message || "Download failed"
        });
      }
    } finally {
      activeDownloads.delete(downloadId);
    }
  }

  function pumpQueue() {
    while (runningCount < DEFAULT_CONCURRENCY && pendingQueue.length > 0) {
      const task = pendingQueue.shift();
      const entry = activeDownloads.get(task.downloadId);
      if (!entry || entry.cancelled) {
        activeDownloads.delete(task.downloadId);
        continue;
      }
      runningCount++;
      executeDownload(task).finally(() => {
        runningCount--;
        pumpQueue();
      });
    }
  }

  function enqueueDownload(task) {
    if (!task?.downloadId || !task?.url) return;
    if (activeDownloads.has(task.downloadId)) return;
    const controller = new AbortController();
    activeDownloads.set(task.downloadId, { controller, cancelled: false });
    pendingQueue.push(task);
    pumpQueue();
  }

  function cancelDownload(downloadId) {
    const entry = activeDownloads.get(downloadId);
    if (!entry) return;
    entry.cancelled = true;
    entry.controller.abort(new DOMException("Download cancelled", "AbortError"));
  }

  async function probeBlobUrl(url) {
    if (!url || !url.startsWith("blob:")) return false;
    try {
      const resp = await fetch(url);
      try {
        await resp.body?.cancel();
      } catch {
        // Ignore stream cancel errors
      }
      return resp.ok;
    } catch {
      return false;
    }
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.source !== MSG_SOURCE || data.direction !== "ext-to-page") {
      return;
    }

    if (data.type === "download") {
      const items = Array.isArray(data.items) ? data.items : [data.item].filter(Boolean);
      items.forEach(enqueueDownload);
    } else if (data.type === "cancel") {
      if (data.downloadId) cancelDownload(data.downloadId);
    } else if (data.type === "get_resource_count") {
      const count = performance.getEntriesByType("resource").length;
      emit("resource_count_result", { requestId: data.requestId, count });
    } else if (data.type === "find_hls") {
      const entries = performance.getEntriesByType("resource");
      const streamUrl = findHlsStreamUrlFromEntries(
        entries,
        Number(data.sinceIndex) || 0,
        Boolean(data.allowFallback)
      );
      emit("hls_result", { requestId: data.requestId, url: streamUrl });
    } else if (data.type === "probe_blob") {
      probeBlobUrl(data.url).then((ok) => {
        emit("probe_blob_result", { requestId: data.requestId, ok });
      });
    }
  });

  performance.addEventListener("resourcetimingbufferfull", () => {
    performance.clearResourceTimings();
  });
})();
