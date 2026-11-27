(() => {
  "use strict";

  if (window.__tmdContentLoaded) return;
  window.__tmdContentLoaded = true;

  const MSG_SOURCE = "tmd-extension";
  const buttonRegistry = new Map(); // downloadId -> { button, defaultLabel }
  const pendingPageRequests = new Map(); // requestId -> resolve
  let scanTimer = null;
  let lastUrl = window.location.href;
  let idCounter = 0;

  function nextId(prefix = "dl") {
    idCounter += 1;
    return `${prefix}_${Date.now().toString(36)}_${idCounter}`;
  }

  function detectClientVersion() {
    const href = window.location.href;
    if (href.includes("web.telegram.org/a")) return "a";
    if (href.includes("web.telegram.org/k")) return "k";
    if (document.querySelector("#MiddleColumn, .MessageList")) return "a";
    if (document.querySelector(".bubbles-inner, #column-center")) return "k";
    return null;
  }

  function postToPage(type, payload = {}) {
    window.postMessage(
      { source: MSG_SOURCE, direction: "ext-to-page", type, ...payload },
      "*"
    );
  }

  function requestFromPage(type, payload = {}, timeoutMs = 2000) {
    return new Promise((resolve) => {
      const requestId = nextId("req");
      const timer = setTimeout(() => {
        pendingPageRequests.delete(requestId);
        resolve(null);
      }, timeoutMs);

      pendingPageRequests.set(requestId, (result) => {
        clearTimeout(timer);
        resolve(result);
      });

      postToPage(type, { ...payload, requestId });
    });
  }

  function reportToBackground(item) {
    try {
      chrome.runtime.sendMessage({ type: "download_upsert", item }).catch(() => {});
    } catch {
      // Ignore if extension context was invalidated
    }
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function waitForSelector(selector, timeoutMs = 4000, predicate = null) {
    return new Promise((resolve) => {
      const check = () => {
        const list = document.querySelectorAll(selector);
        for (const el of list) {
          if (!predicate || predicate(el)) return el;
        }
        return null;
      };

      const initial = check();
      if (initial) return resolve(initial);

      const timer = setTimeout(() => {
        observer.disconnect();
        resolve(null);
      }, timeoutMs);

      const observer = new MutationObserver(() => {
        const match = check();
        if (match) {
          clearTimeout(timer);
          observer.disconnect();
          resolve(match);
        }
      });

      observer.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["src", "class"]
      });
    });
  }

  function simulateClick(el) {
    if (!el) return;
    ["mouseover", "mousedown", "mouseup", "click"].forEach((type) => {
      el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true }));
    });
  }

  function getMediaElementUrl(el) {
    if (!el) return "";
    const direct = el.getAttribute("src") || el.currentSrc || "";
    if (direct && !direct.startsWith("data:")) return direct;
    const source = el.querySelector("source");
    const sourceSrc = source?.getAttribute("src") || "";
    return sourceSrc && !sourceSrc.startsWith("data:") ? sourceSrc : "";
  }

  function isDirectStreamUrl(url) {
    return Boolean(
      url && (url.includes("stream/") || url.includes("progressive/"))
    );
  }

  async function isUsableMediaUrl(url) {
    if (!url || url.startsWith("data:")) return false;
    if (!url.startsWith("blob:")) return true;
    const res = await requestFromPage("probe_blob", { url }, 2500);
    return Boolean(res?.ok);
  }

  async function getResourceCountFromPage() {
    const res = await requestFromPage("get_resource_count", {}, 1500);
    return typeof res?.count === "number" ? res.count : 0;
  }

  async function findHlsStreamUrlFromPage(sinceIndex = 0, allowFallback = false) {
    const res = await requestFromPage(
      "find_hls",
      { sinceIndex, allowFallback },
      1500
    );
    return res?.url || null;
  }

  function createDownloadButton(label, extraClass = "") {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `tmd-download-btn ${extraClass}`.trim();
    btn.dataset.defaultLabel = label;
    ["pointerdown", "mousedown", "mouseup"].forEach((ev) => {
      btn.addEventListener(ev, (e) => e.stopPropagation());
    });
    setButtonIdle(btn, label);
    return btn;
  }

  function createButtonRow() {
    const row = document.createElement("div");
    row.className = "tmd-btn-row";
    ["pointerdown", "mousedown", "mouseup", "click"].forEach((ev) => {
      row.addEventListener(ev, (e) => e.stopPropagation());
    });
    return row;
  }

  // ---------- Copy message text ----------

  const MESSAGE_TEXT_SELECTORS = [".text-content", ".message", ".bubble-content"];
  const TEXT_EXCLUDE_SELECTOR = [
    ".time",
    ".message-time",
    ".time-inner",
    "time",
    ".message-title",
    ".peer-title",
    ".sender-title",
    ".reactions",
    ".reply",
    ".EmbeddedMessage",
    ".webpage",
    ".WebPage",
    ".forward-header",
    ".tmd-btn-row",
    "button",
    "video",
    "audio",
    "img",
    "canvas",
    "svg"
  ].join(", ");
  // Text inside these belongs to a quoted reply, a forwarded block or a link preview,
  // not to the message itself.
  const TEXT_EXCLUDE_ANCESTOR_SELECTOR = [
    ".reply",
    ".EmbeddedMessage",
    ".webpage",
    ".WebPage",
    ".forward-header",
    ".tmd-btn-row"
  ].join(", ");

  function normalizeMessageText(raw) {
    return (raw || "")
      .replace(/\u00a0/g, " ")
      .split("\n")
      .map((line) => line.replace(/[ \t]+/g, " ").trimEnd())
      .join("\n")
      .replace(/^\s*\n+/, "")
      .replace(/\n+\s*$/, "")
      .trim();
  }

  function extractMessageText(node) {
    // Work on a copy so timestamps, sender names, replies and the extension's own
    // buttons never end up in the clipboard. Reading the DOM needs no text selection,
    // so this also works where the page disables selecting and copying.
    const clone = node.cloneNode(true);
    clone.querySelectorAll(TEXT_EXCLUDE_SELECTOR).forEach((el) => el.remove());
    clone.querySelectorAll("br").forEach((br) => br.replaceWith("\n"));
    return normalizeMessageText(clone.textContent);
  }

  function getMessageText(wrapper) {
    if (!wrapper) return "";
    for (const selector of MESSAGE_TEXT_SELECTORS) {
      for (const node of wrapper.querySelectorAll(selector)) {
        if (!node.textContent?.trim()) continue;
        if (node.closest(TEXT_EXCLUDE_ANCESTOR_SELECTOR)) continue;
        const text = extractMessageText(node);
        if (text) return text;
      }
    }
    return "";
  }

  async function writeClipboard(text) {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch {
      // Needs a focused document and a user gesture; fall back to execCommand below
    }
    try {
      const area = document.createElement("textarea");
      area.value = text;
      area.setAttribute("readonly", "");
      area.style.cssText = "position: fixed; top: -1000px; left: -1000px; opacity: 0;";
      document.body.appendChild(area);
      area.select();
      area.setSelectionRange(0, area.value.length);
      const ok = document.execCommand("copy");
      area.remove();
      return ok;
    } catch {
      return false;
    }
  }

  function createCopyButton(label = "Copy Text") {
    const btn = createDownloadButton(label, "tmd-copy-btn");
    btn.dataset.icon = "📋";
    setButtonIdle(btn, label);
    return btn;
  }

  async function copyMessageText(wrapper, btn) {
    const text = getMessageText(wrapper);
    if (!text) {
      setButtonError(btn, "No text found");
      return;
    }
    if (!(await writeClipboard(text))) {
      setButtonError(btn, "Clipboard unavailable");
      return;
    }
    const label = btn.dataset.defaultLabel || "Copy Text";
    btn.disabled = false;
    btn.replaceChildren();
    const icon = document.createElement("span");
    icon.textContent = "✓";
    const done = document.createElement("span");
    done.textContent = "Copied";
    btn.append(icon, done);
    setTimeout(() => {
      if (btn.isConnected) setButtonIdle(btn, label);
    }, 1400);
  }

  function ensureCopyRow(wrapper) {
    if (wrapper.querySelector(".tmd-copy-btn")) return;
    if (!getMessageText(wrapper)) return;
    let row = wrapper.querySelector(":scope > .tmd-btn-row");
    if (!row) {
      row = createButtonRow();
      row.classList.add("tmd-copy-row");
      wrapper.appendChild(row);
    }
    const btn = createCopyButton();
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      e.preventDefault();
      copyMessageText(wrapper, btn);
    });
    row.appendChild(btn);
  }

  const NON_MEDIA_ANCESTOR_SELECTOR =
    "a[href], .avatar, .Avatar, .name, .peer-title, .message-title, .sender-title, .reply, .EmbeddedMessage, .webpage, .WebPage, .forward-header, .forwarded-from";

  function isPrimaryMediaEl(el) {
    return Boolean(el && !el.closest(NON_MEDIA_ANCESTOR_SELECTOR));
  }

  function queryPrimaryMediaAll(root, selector) {
    return Array.from(root.querySelectorAll(selector)).filter(isPrimaryMediaEl);
  }

  function queryPrimaryMediaOrdered(root, selectors) {
    for (const sel of selectors) {
      const match = queryPrimaryMediaAll(root, sel)[0];
      if (match) return match;
    }
    return null;
  }

  function setButtonIdle(btn, labelOverride) {
    if (!btn) return;
    const label = labelOverride || btn.dataset.defaultLabel || "Download";
    btn.disabled = false;
    btn.replaceChildren();
    const icon = document.createElement("span");
    icon.textContent = btn.dataset.icon || "⬇";
    const text = document.createElement("span");
    text.textContent = label;
    btn.append(icon, text);
  }

  function setButtonError(btn, message = "Retry") {
    if (!btn) return;
    btn.disabled = false;
    btn.title = message;
    btn.replaceChildren();
    const icon = document.createElement("span");
    icon.textContent = "⚠";
    const text = document.createElement("span");
    text.textContent = "Failed — Retry";
    btn.append(icon, text);
    setTimeout(() => {
      if (!btn.disabled && btn.textContent?.includes("Failed")) {
        btn.title = "";
        setButtonIdle(btn);
      }
    }, 3500);
  }

  function setButtonProgress(btn, downloadId, progress, statusText = "Preparing...") {
    if (!btn) return;
    btn.disabled = true;
    btn.replaceChildren();
    const text = document.createElement("span");
    text.textContent = progress > 0 ? `${Math.round(progress)}%` : statusText;
    btn.appendChild(text);

    if (downloadId && progress < 100) {
      const cancel = document.createElement("span");
      cancel.className = "tmd-cancel-pill";
      cancel.textContent = "✕";
      cancel.title = "Cancel";
      cancel.addEventListener("click", (e) => {
        e.stopPropagation();
        e.preventDefault();
        postToPage("cancel", { downloadId });
      });
      btn.appendChild(cancel);
    }
  }

  function queueMediaDownload({ url, mediaType, itemId, button, suggestedName }) {
    if (!url) return null;
    const downloadId = nextId("dl");
    if (button) {
      buttonRegistry.set(downloadId, {
        button,
        defaultLabel: button.dataset.defaultLabel || "Download"
      });
      setButtonProgress(button, downloadId, 0, "Starting...");
    }

    reportToBackground({
      downloadId,
      itemId: itemId || downloadId,
      mediaType: mediaType || "media",
      filename: suggestedName || `${mediaType || "media"}_${itemId || downloadId}`,
      status: "queued",
      progress: 0
    });

    postToPage("download", {
      item: { downloadId, url, mediaType, itemId, suggestedName }
    });
    return downloadId;
  }

  // ---------- Web A helpers ----------

  function getMessageIdA(wrapper) {
    return (
      wrapper.closest("[data-message-id]")?.getAttribute("data-message-id") ||
      wrapper.parentElement?.getAttribute("data-message-id") ||
      ""
    );
  }

  function classifyWrapperA(wrapper) {
    const audioEl = queryPrimaryMediaOrdered(wrapper, [".Audio"]);
    const videos = queryPrimaryMediaAll(wrapper, "video.full-media");
    const images = queryPrimaryMediaAll(wrapper, "img.full-media");
    const hasDuration = queryPrimaryMediaAll(wrapper, ".message-media-duration").length > 0;
    const albumWrappers = queryPrimaryMediaAll(wrapper, ".album-item-select-wrapper");
    const albumContainers = queryPrimaryMediaAll(wrapper, ".Album .media-inner");

    if (audioEl && videos.length === 0) {
      return { kind: "audio", audioEl };
    }
    if (albumWrappers.length > 1 || albumContainers.length > 1) {
      return { kind: "album", albumWrappers, videos, images };
    }
    if (videos.length >= 1 || hasDuration) {
      const thumbEl =
        images[0] ||
        queryPrimaryMediaOrdered(wrapper, [
          ".media-inner img.thumbnail",
          ".VideoPlayer",
          ".media-inner"
        ]);
      return { kind: "video", videoEl: videos[0] || null, thumbEl };
    }
    if (images.length === 1) {
      return { kind: "image", imgEl: images[0] };
    }
    return { kind: "none" };
  }

  async function closeMediaViewerA() {
    const actions = document.querySelector(".MediaViewerActions");
    if (!actions) return;
    const closeBtn =
      actions.querySelector('button[aria-label*="Close" i], button[title*="Close" i]') ||
      Array.from(actions.querySelectorAll(".Button.smaller.round")).pop();
    if (closeBtn) {
      simulateClick(closeBtn);
      await sleep(250);
    }
  }

  function triggerNativeViewerDownloadA() {
    const actions = document.querySelector(".MediaViewerActions");
    if (!actions) return false;
    const dlBtn = actions.querySelector(
      'button[aria-label*="Download" i], button[title*="Download" i]'
    );
    if (dlBtn) {
      simulateClick(dlBtn);
      return true;
    }
    return false;
  }

  async function resolveFromViewerA(clickableEl, expectVideo = false, inlineVideoEl = null) {
    if (!isPrimaryMediaEl(clickableEl)) return null;
    clickableEl.click();
    let activeSlide = await waitForSelector(".MediaViewerSlide--active", 2200);
    if (!activeSlide) {
      const inlineSrc = getMediaElementUrl(inlineVideoEl);
      if (expectVideo && inlineSrc && (isDirectStreamUrl(inlineSrc) || (await isUsableMediaUrl(inlineSrc)))) {
        return { url: inlineSrc, mediaType: "video" };
      }
      const container = clickableEl.closest(".media-inner, .VideoPlayer");
      if (!isPrimaryMediaEl(container)) return null;
      simulateClick(container);
      activeSlide = await waitForSelector(".MediaViewerSlide--active", 2500);
    }
    if (!activeSlide) return null;

    let mediaUrl = "";
    let mediaType = "";
    const deadline = Date.now() + 12_000;

    while (Date.now() < deadline) {
      const slide = document.querySelector(".MediaViewerSlide--active") || activeSlide;
      const videoEl = slide.querySelector("video");
      const imgEl = !expectVideo ? slide.querySelector("img") : null;
      const candidateEl = videoEl || imgEl;

      if (candidateEl) {
        const candidateUrl = getMediaElementUrl(candidateEl);
        if (candidateUrl) {
          if (isDirectStreamUrl(candidateUrl) || (await isUsableMediaUrl(candidateUrl))) {
            mediaUrl = candidateUrl;
            mediaType = candidateEl.tagName === "VIDEO" ? "video" : "image";
            break;
          }
        }
      }
      await sleep(300);
    }

    if (!mediaUrl && expectVideo) {
      if (triggerNativeViewerDownloadA()) {
        await sleep(500);
        await closeMediaViewerA();
        return { nativeTriggered: true };
      }
    }

    await closeMediaViewerA();
    return mediaUrl ? { url: mediaUrl, mediaType } : null;
  }

  async function downloadAudioA(audioEl, msgId, button) {
    const nativeBtn = audioEl.querySelector(".download-button");
    if (nativeBtn) {
      simulateClick(nativeBtn);
      reportToBackground({
        downloadId: nextId("audio"),
        itemId: msgId,
        mediaType: "audio",
        filename: `tg_audio_${msgId}`,
        status: "done",
        progress: 100
      });
      return;
    }

    const playBtn = audioEl.querySelector(".toggle-play, button");
    if (!playBtn) return;

    const beforeUrls = new Set(
      Array.from(document.querySelectorAll("audio"))
        .map((a) => a.src)
        .filter(Boolean)
    );
    playBtn.click();

    const activeAudio = await waitForSelector("audio", 6000, (el) => {
      return Boolean(el.src && (!el.paused || !beforeUrls.has(el.src)));
    });

    const audioSrc = activeAudio?.src || "";
    if (activeAudio && !activeAudio.paused) {
      playBtn.click();
    }

    if (audioSrc) {
      queueMediaDownload({
        url: audioSrc,
        mediaType: "audio",
        itemId: msgId,
        button
      });
    } else if (button) {
      setButtonError(button, "Could not locate audio stream");
    }
  }

  function injectMessageButtonA(wrapper) {
    if (wrapper.querySelector(":scope > .tmd-btn-row:not(.tmd-copy-row)")) return;
    const info = classifyWrapperA(wrapper);
    if (info.kind === "none") return;

    const msgId = getMessageIdA(wrapper);
    const row = createButtonRow();

    if (info.kind === "audio") {
      const btn = createDownloadButton("Download Audio", "tmd-audio-btn");
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        downloadAudioA(info.audioEl, msgId, btn);
      });
      row.appendChild(btn);
      wrapper.appendChild(row);
      return;
    }

    if (info.kind === "image") {
      const btn = createDownloadButton("Download Image", "tmd-single-btn");
      btn.dataset.tmdKind = "image";
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const src = getMediaElementUrl(info.imgEl);
        if (src && (await isUsableMediaUrl(src))) {
          queueMediaDownload({ url: src, mediaType: "image", itemId: msgId, button: btn });
          return;
        }
        setButtonProgress(btn, null, 0, "Loading...");
        const resolved = await resolveFromViewerA(info.imgEl, false);
        if (resolved?.url) {
          queueMediaDownload({
            url: resolved.url,
            mediaType: resolved.mediaType,
            itemId: msgId,
            button: btn
          });
        } else {
          setButtonError(btn, "Could not resolve image URL");
        }
      });
      row.appendChild(btn);
      wrapper.appendChild(row);
      return;
    }

    if (info.kind === "video") {
      const btn = createDownloadButton("Download Video", "tmd-single-btn");
      btn.dataset.tmdKind = "video";
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const directSrc = getMediaElementUrl(info.videoEl);
        if (
          directSrc &&
          (isDirectStreamUrl(directSrc) || (await isUsableMediaUrl(directSrc)))
        ) {
          queueMediaDownload({ url: directSrc, mediaType: "video", itemId: msgId, button: btn });
          return;
        }
        const clickTarget = info.videoEl || info.thumbEl;
        if (!clickTarget) {
          setButtonError(btn, "Video element not found");
          return;
        }
        setButtonProgress(btn, null, 0, "Loading...");
        const resolved = await resolveFromViewerA(clickTarget, true, info.videoEl);
        if (resolved?.nativeTriggered) {
          setButtonIdle(btn);
        } else if (resolved?.url) {
          queueMediaDownload({
            url: resolved.url,
            mediaType: resolved.mediaType,
            itemId: msgId,
            button: btn
          });
        } else {
          setButtonError(btn, "Could not resolve video stream");
        }
      });
      row.appendChild(btn);
      wrapper.appendChild(row);
      return;
    }

    if (info.kind === "album") {
      info.albumWrappers.forEach((cell) => {
        cell.classList.add("tmd-album-checkbox-host");
        if (!cell.querySelector(".tmd-album-checkbox")) {
          const cb = document.createElement("input");
          cb.type = "checkbox";
          cb.checked = true;
          cb.className = "tmd-album-checkbox";
          cb.addEventListener("click", (ev) => ev.stopPropagation());
          cell.appendChild(cb);
        }
      });

      const btn = createDownloadButton("Download Selected", "tmd-album-btn");
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const mediaEls = Array.from(wrapper.querySelectorAll(".full-media"));
        const targets = mediaEls.filter((el) => {
          const host = el.closest(".album-item-select-wrapper");
          const cb = host?.querySelector(".tmd-album-checkbox");
          return !cb || cb.checked;
        });
        if (targets.length === 0) return;

        setButtonProgress(btn, null, 0, "Loading...");
        for (let i = 0; i < targets.length; i++) {
          const el = targets[i];
          const itemMid =
            el.closest("[data-message-id]")?.getAttribute("data-message-id") ||
            `${msgId}_${i + 1}`;
          const isVideo =
            el.tagName === "VIDEO" ||
            Boolean(el.closest(".media-inner")?.querySelector(".message-media-duration"));
          const resolved = await resolveFromViewerA(el, isVideo);
          if (resolved?.url) {
            queueMediaDownload({
              url: resolved.url,
              mediaType: resolved.mediaType,
              itemId: itemMid
            });
          }
        }
        setButtonIdle(btn);
      });
      row.appendChild(btn);
      wrapper.appendChild(row);
    }
  }

  // ---------- Web K helpers ----------

  function getMessageIdK(wrapper) {
    return (
      wrapper.closest("[data-mid]")?.getAttribute("data-mid") ||
      wrapper.parentElement?.getAttribute("data-mid") ||
      ""
    );
  }

  function classifyWrapperK(wrapper) {
    const audioEl = queryPrimaryMediaOrdered(wrapper, [".audio"]);
    const videos = queryPrimaryMediaAll(wrapper, "video.media-video");
    const images = queryPrimaryMediaAll(wrapper, "img.media-photo");
    const albumItems = queryPrimaryMediaAll(wrapper, ".album-item");
    const hasVideoTime = queryPrimaryMediaAll(wrapper, ".video-time").length > 0;

    if (audioEl && videos.length === 0) {
      return { kind: "audio", wrapper };
    }
    if (albumItems.length > 1) {
      return { kind: "album", albumItems, images, videos };
    }
    if (videos.length >= 1 || hasVideoTime) {
      const thumbEl =
        images[0] ||
        queryPrimaryMediaOrdered(wrapper, [
          ".media-container img.media-photo",
          ".media-container video",
          ".media-container",
          ".attachment .media-photo",
          ".attachment"
        ]);
      return {
        kind: "video",
        videoEl: videos[0] || null,
        thumbEl
      };
    }
    if (images.length === 1) {
      return { kind: "image", imgEl: images[0] };
    }
    return { kind: "none" };
  }

  async function closeMediaViewerK() {
    const viewer = document.querySelector(".media-viewer-whole");
    if (!viewer) return;
    const btns = Array.from(viewer.querySelectorAll(".media-viewer-buttons .btn-icon"));
    const closeBtn =
      btns.find((b) => b.classList.contains("tgico-close") || /close/i.test(b.title || "")) ||
      btns[4] ||
      btns[btns.length - 1];
    if (closeBtn) {
      simulateClick(closeBtn);
      await sleep(250);
    }
  }

  async function triggerNativeViewerDownloadK() {
    const viewer = document.querySelector(".media-viewer-whole");
    if (!viewer) return false;
    const btns = Array.from(viewer.querySelectorAll(".media-viewer-buttons .btn-icon"));
    const dlBtn =
      btns.find(
        (b) =>
          b.classList.contains("tgico-download") ||
          /download/i.test(b.title || "") ||
          /download/i.test(b.getAttribute("aria-label") || "")
      ) || btns[2];
    if (!dlBtn) return false;

    simulateClick(dlBtn);
    const qualityMenu = await waitForSelector(
      ".quality-download-options-button-menu.menu-open",
      2200
    );
    if (qualityMenu) {
      const firstQuality = qualityMenu.querySelector(".btn-menu-item");
      if (firstQuality) {
        simulateClick(firstQuality);
        await sleep(400);
      }
    }
    await sleep(300);
    return true;
  }

  async function resolveFromViewerK(clickableEl, preferVideo = false, inlineVideoEl = null) {
    if (!isPrimaryMediaEl(clickableEl)) return null;

    const resourceStartIndex = await getResourceCountFromPage();

    clickableEl.click();
    let aspecter = await waitForSelector(".media-viewer-movers .media-viewer-aspecter", 2200);
    if (!aspecter) {
      const inlineSrc = getMediaElementUrl(inlineVideoEl);
      if (preferVideo && isDirectStreamUrl(inlineSrc)) {
        return { url: inlineSrc, mediaType: "video" };
      }
      const container = clickableEl.closest(".media-container, .attachment");
      if (!isPrimaryMediaEl(container)) return null;
      simulateClick(container);
      aspecter = await waitForSelector(".media-viewer-movers .media-viewer-aspecter", 2500);
    }
    if (!aspecter) return null;

    let mediaUrl = "";
    let mediaType = "";
    const deadline = Date.now() + 12_000;
    let lastFallbackVideoBlob = "";

    while (Date.now() < deadline) {
      const currentAspecter =
        document.querySelector(".media-viewer-movers .media-viewer-aspecter") || aspecter;

      if (preferVideo) {
        const videoEl = currentAspecter.querySelector("video");
        const videoSrc = getMediaElementUrl(videoEl);

        if (isDirectStreamUrl(videoSrc)) {
          mediaUrl = videoSrc;
          mediaType = "video";
          break;
        }

        // Prefer HLS -> stream/ URL if available
        const hlsStream = await findHlsStreamUrlFromPage(resourceStartIndex, false);
        if (hlsStream) {
          mediaUrl = hlsStream;
          mediaType = "video";
          break;
        }

        if (videoSrc && videoSrc.startsWith("blob:") && !lastFallbackVideoBlob) {
          if (await isUsableMediaUrl(videoSrc)) {
            lastFallbackVideoBlob = videoSrc;
          }
        }
      } else {
        const imgEl = currentAspecter.querySelector("img");
        const imgSrc = getMediaElementUrl(imgEl);
        if (imgSrc && (isDirectStreamUrl(imgSrc) || (await isUsableMediaUrl(imgSrc)))) {
          mediaUrl = imgSrc;
          mediaType = "image";
          break;
        }
      }

      await sleep(350);
    }

    if (!mediaUrl && preferVideo) {
      // Check older resource timings in case the video was already cached from earlier playback
      const fallbackHls = await findHlsStreamUrlFromPage(resourceStartIndex, true);
      if (fallbackHls) {
        mediaUrl = fallbackHls;
        mediaType = "video";
      } else if (lastFallbackVideoBlob) {
        mediaUrl = lastFallbackVideoBlob;
        mediaType = "video";
      } else if (await triggerNativeViewerDownloadK()) {
        await closeMediaViewerK();
        return { nativeTriggered: true };
      }
    }

    await closeMediaViewerK();
    return mediaUrl ? { url: mediaUrl, mediaType: mediaType || (preferVideo ? "video" : "image") } : null;
  }

  async function downloadAudioK(docEl, msgId, button) {
    const playIcon = docEl.querySelector(".audio-play-icon");
    if (!playIcon) {
      if (button) setButtonError(button, "Audio play button not found");
      return;
    }

    const wasPlaying = playIcon.parentElement?.classList.contains("playing");
    if (!wasPlaying) {
      playIcon.click();
    }

    const startedAt = Date.now();
    while (Date.now() - startedAt < 15_000) {
      const pending = document.querySelectorAll(
        "div.audio-download > div.preloader-container.is-visible"
      );
      if (pending.length === 0) break;
      await sleep(300);
    }

    const audios = Array.from(document.querySelectorAll("audio"));
    const playingAudio =
      audios.find((a) => !a.paused && a.src) || audios.find((a) => Boolean(a.src));
    const audioSrc = playingAudio?.src || "";

    if (!wasPlaying && playIcon.parentElement?.classList.contains("playing")) {
      playIcon.click();
    }

    if (audioSrc) {
      queueMediaDownload({
        url: audioSrc,
        mediaType: "audio",
        itemId: msgId,
        button
      });
    } else if (button) {
      setButtonError(button, "Could not locate audio stream");
    }
  }

  function injectMessageButtonK(wrapper) {
    if (wrapper.querySelector(":scope > .tmd-btn-row:not(.tmd-copy-row)")) return;
    const info = classifyWrapperK(wrapper);
    if (info.kind === "none") return;

    const msgId = getMessageIdK(wrapper);

    if (info.kind === "audio") {
      const spoilers = wrapper.querySelector(".spoilers-container");
      const docItems = spoilers ? spoilers.querySelectorAll(".document-container") : [];
      const targets = docItems.length > 1 ? Array.from(docItems) : [wrapper];

      targets.forEach((target) => {
        if (target.querySelector(":scope > .tmd-btn-row")) return;
        const targetMid = target.getAttribute("data-mid") || msgId;
        const row = createButtonRow();
        const btn = createDownloadButton("Download Audio", "tmd-audio-btn");
        btn.addEventListener("click", (e) => {
          e.stopPropagation();
          e.preventDefault();
          setButtonProgress(btn, null, 0, "Loading...");
          downloadAudioK(target, targetMid, btn);
        });
        row.appendChild(btn);
        target.appendChild(row);
      });
      return;
    }

    const row = createButtonRow();

    if (info.kind === "image") {
      const btn = createDownloadButton("Download Image", "tmd-single-btn");
      btn.dataset.tmdKind = "image";
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        e.preventDefault();
        const src = getMediaElementUrl(info.imgEl);
        if (src && (await isUsableMediaUrl(src))) {
          queueMediaDownload({ url: src, mediaType: "image", itemId: msgId, button: btn });
          return;
        }
        setButtonProgress(btn, null, 0, "Loading...");
        const resolved = await resolveFromViewerK(info.imgEl, false);
        if (resolved?.url) {
          queueMediaDownload({
            url: resolved.url,
            mediaType: "image",
            itemId: msgId,
            button: btn
          });
        } else {
          setButtonError(btn, "Could not resolve image URL");
        }
      });
      row.appendChild(btn);
      wrapper.appendChild(row);
      return;
    }

    if (info.kind === "video") {
      const btn = createDownloadButton("Download Video", "tmd-single-btn");
      btn.dataset.tmdKind = "video";
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        e.preventDefault();
        const directSrc = getMediaElementUrl(info.videoEl);
        if (isDirectStreamUrl(directSrc)) {
          queueMediaDownload({ url: directSrc, mediaType: "video", itemId: msgId, button: btn });
          return;
        }
        const clickTarget = info.videoEl || info.thumbEl;
        if (!clickTarget) {
          setButtonError(btn, "Video element not found");
          return;
        }
        setButtonProgress(btn, null, 0, "Loading...");
        const resolved = await resolveFromViewerK(clickTarget, true, info.videoEl);
        if (resolved?.nativeTriggered) {
          setButtonIdle(btn);
        } else if (resolved?.url) {
          queueMediaDownload({
            url: resolved.url,
            mediaType: "video",
            itemId: msgId,
            button: btn
          });
        } else if (directSrc && (await isUsableMediaUrl(directSrc))) {
          queueMediaDownload({ url: directSrc, mediaType: "video", itemId: msgId, button: btn });
        } else {
          setButtonError(btn, "Could not resolve video stream");
        }
      });
      row.appendChild(btn);
      wrapper.appendChild(row);
      return;
    }

    if (info.kind === "album") {
      const items =
        info.albumItems.length > 0
          ? Array.from(info.albumItems)
          : Array.from(wrapper.querySelectorAll("img.media-photo, video.media-video"));

      items.forEach((cell) => {
        cell.classList.add("tmd-album-checkbox-host");
        if (!cell.querySelector(".tmd-album-checkbox")) {
          const cb = document.createElement("input");
          cb.type = "checkbox";
          cb.checked = true;
          cb.className = "tmd-album-checkbox";
          cb.addEventListener("click", (ev) => ev.stopPropagation());
          cell.appendChild(cb);
        }
      });

      const btn = createDownloadButton("Download Selected", "tmd-album-btn");
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const selected = items.filter((cell) => {
          const cb = cell.querySelector(".tmd-album-checkbox");
          return !cb || cb.checked;
        });
        if (selected.length === 0) return;

        setButtonProgress(btn, null, 0, "Loading...");
        for (let i = 0; i < selected.length; i++) {
          const cell = selected[i];
          const itemMid =
            cell.getAttribute("data-mid") ||
            cell.closest("[data-mid]")?.getAttribute("data-mid") ||
            `${msgId}_${i + 1}`;
          const isVideo = Boolean(cell.querySelector(".video-time, video.media-video"));
          const clickTarget =
            cell.querySelector("video.media-video, img.media-photo") || cell;

          if (!isVideo) {
            const imgSrc = getMediaElementUrl(cell.querySelector("img.media-photo"));
            if (imgSrc && (await isUsableMediaUrl(imgSrc))) {
              queueMediaDownload({ url: imgSrc, mediaType: "image", itemId: itemMid });
              continue;
            }
          }
          const resolved = await resolveFromViewerK(clickTarget, isVideo);
          if (resolved?.url) {
            queueMediaDownload({
              url: resolved.url,
              mediaType: resolved.mediaType,
              itemId: itemMid
            });
          }
        }
        setButtonIdle(btn);
      });
      row.appendChild(btn);
      wrapper.appendChild(row);
    }
  }

  // ---------- Media Viewer toolbar button ----------

  function injectViewerButton(version) {
    if (version === "a") {
      const actions = document.querySelector(".MediaViewerActions");
      if (!actions || actions.querySelector(".tmd-viewer-btn")) return;

      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "tmd-viewer-btn";
      btn.dataset.defaultLabel = "Download";
      btn.textContent = "⬇ Download";
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const slide = document.querySelector(".MediaViewerSlide--active");
        if (!slide) return;
        const video = slide.querySelector("video");
        const img = slide.querySelector("img");
        const src = getMediaElementUrl(video) || getMediaElementUrl(img);
        if (src && (isDirectStreamUrl(src) || (await isUsableMediaUrl(src)))) {
          queueMediaDownload({
            url: src,
            mediaType: video ? "video" : "image",
            itemId: nextId("viewer"),
            button: btn
          });
        } else if (video) {
          triggerNativeViewerDownloadA();
        }
      });
      actions.prepend(btn);
    } else if (version === "k") {
      const actions = document.querySelector(".media-viewer-buttons");
      if (!actions || actions.querySelector(".tmd-viewer-btn")) return;

      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "tmd-viewer-btn";
      btn.dataset.defaultLabel = "Download";
      btn.textContent = "⬇ Download";
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const aspecter = document.querySelector(".media-viewer-movers .media-viewer-aspecter");
        const video = aspecter?.querySelector("video");
        const img = aspecter?.querySelector("img");
        let src = getMediaElementUrl(video) || getMediaElementUrl(img);
        let mediaType = video ? "video" : "image";

        if (video && !isDirectStreamUrl(src)) {
          const hls = await findHlsStreamUrlFromPage(0, true);
          if (hls) {
            src = hls;
            mediaType = "video";
          }
        }
        if (src && (isDirectStreamUrl(src) || (await isUsableMediaUrl(src)))) {
          queueMediaDownload({
            url: src,
            mediaType,
            itemId: nextId("viewer"),
            button: btn
          });
        } else if (video) {
          await triggerNativeViewerDownloadK();
        }
      });
      actions.prepend(btn);
    }
  }

  // ---------- Shared Media panel helpers ----------

  function injectSharedMediaA() {
    const panel = document.querySelector(
      "#RightColumn .shared-media .Transition_slide-active.media-list"
    );
    if (!panel) return;
    const items = Array.from(panel.querySelectorAll(".scroll-item"));
    if (items.length === 0) return;

    const host = document.querySelector(".shared-media-transition")?.parentElement;
    if (host && !host.querySelector(".tmd-shared-toolbar")) {
      const bar = document.createElement("div");
      bar.className = "tmd-shared-toolbar";
      const allBtn = createDownloadButton("Download All Shared Media", "tmd-download-btn--batch");
      allBtn.addEventListener("click", async () => {
        setButtonProgress(allBtn, null, 0, "Loading...");
        const currentItems = Array.from(
          document.querySelectorAll(
            "#RightColumn .shared-media .Transition_slide-active.media-list .scroll-item"
          )
        );
        for (const item of currentItems) {
          const id = item.getAttribute("id") || nextId("shared");
          const isVideo = Boolean(item.querySelector(".message-media-duration, video"));
          const resolved = await resolveFromViewerA(item, isVideo);
          if (resolved?.url) {
            queueMediaDownload({
              url: resolved.url,
              mediaType: resolved.mediaType,
              itemId: id
            });
          }
        }
        setButtonIdle(allBtn);
      });
      bar.appendChild(allBtn);
      host.prepend(bar);
    }

    items.forEach((item) => {
      if (item.querySelector(".tmd-shared-item-btn")) return;
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "tmd-shared-item-btn";
      btn.textContent = "⬇";
      btn.title = "Download";
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const id = item.getAttribute("id") || nextId("shared");
        const isVideo = Boolean(item.querySelector(".message-media-duration, video"));
        const resolved = await resolveFromViewerA(item, isVideo);
        if (resolved?.url) {
          queueMediaDownload({
            url: resolved.url,
            mediaType: resolved.mediaType,
            itemId: id
          });
        }
      });
      item.appendChild(btn);
    });
  }

  function injectSharedMediaK() {
    const panel = document.querySelector(
      "#column-right .search-super-tab-container.active.search-super-container-media"
    );
    if (!panel) return;
    const items = Array.from(panel.querySelectorAll(".media-container"));
    if (items.length === 0) return;

    const superRoot = document.querySelector("#column-right .search-super");
    if (superRoot && !superRoot.querySelector(".tmd-shared-toolbar")) {
      const bar = document.createElement("div");
      bar.className = "tmd-shared-toolbar";
      const allBtn = createDownloadButton("Download All Shared Media", "tmd-download-btn--batch");
      allBtn.addEventListener("click", async () => {
        setButtonProgress(allBtn, null, 0, "Loading...");
        const currentItems = Array.from(
          document.querySelectorAll(
            "#column-right .search-super-container-media.active .media-container"
          )
        );
        for (const item of currentItems) {
          const id = item.getAttribute("data-mid") || nextId("shared");
          const isVideo = Boolean(item.querySelector(".video-time"));
          const resolved = await resolveFromViewerK(item, isVideo);
          if (resolved?.url) {
            queueMediaDownload({
              url: resolved.url,
              mediaType: resolved.mediaType,
              itemId: id
            });
          }
        }
        setButtonIdle(allBtn);
      });
      bar.appendChild(allBtn);
      superRoot.prepend(bar);
    }

    items.forEach((item) => {
      if (item.querySelector(".tmd-shared-item-btn")) return;
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "tmd-shared-item-btn";
      btn.textContent = "⬇";
      btn.title = "Download";
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const id = item.getAttribute("data-mid") || nextId("shared");
        const isVideo = Boolean(item.querySelector(".video-time"));
        const resolved = await resolveFromViewerK(item, isVideo);
        if (resolved?.url) {
          queueMediaDownload({
            url: resolved.url,
            mediaType: resolved.mediaType,
            itemId: id
          });
        }
      });
      item.appendChild(btn);
    });
  }

  // ---------- Scan & lifecycle ----------

  function scanPage() {
    const version = detectClientVersion();
    if (!version) return;

    if (version === "a") {
      document.querySelectorAll(".message-content-wrapper").forEach((wrapper) => {
        injectMessageButtonA(wrapper);
        ensureCopyRow(wrapper);
      });
      injectViewerButton("a");
      injectSharedMediaA();
    } else {
      document.querySelectorAll(".bubble-content-wrapper").forEach((wrapper) => {
        injectMessageButtonK(wrapper);
        ensureCopyRow(wrapper);
      });
      injectViewerButton("k");
      injectSharedMediaK();
    }
  }

  function scheduleScan() {
    if (scanTimer) return;
    scanTimer = setTimeout(() => {
      scanTimer = null;
      scanPage();
    }, 180);
  }

  // Listen to page-downloader events
  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.source !== MSG_SOURCE || data.direction !== "page-to-ext") {
      return;
    }

    if (
      (data.type === "hls_result" ||
        data.type === "resource_count_result" ||
        data.type === "probe_blob_result") &&
      data.requestId
    ) {
      const resolve = pendingPageRequests.get(data.requestId);
      if (resolve) {
        pendingPageRequests.delete(data.requestId);
        resolve(data);
      }
      return;
    }

    const { downloadId, itemId, progress, sizeBytes, filename, error } = data;
    if (!downloadId) return;
    const reg = buttonRegistry.get(downloadId);

    if (data.type === "progress") {
      if (reg) setButtonProgress(reg.button, downloadId, progress || 0);
      reportToBackground({
        downloadId,
        itemId,
        status: "downloading",
        progress: progress || 0,
        sizeBytes
      });
    } else if (data.type === "done") {
      if (reg) {
        setButtonIdle(reg.button, reg.defaultLabel);
        buttonRegistry.delete(downloadId);
      }
      reportToBackground({
        downloadId,
        itemId,
        filename,
        sizeBytes,
        status: "done",
        progress: 100
      });
    } else if (data.type === "canceled") {
      if (reg) {
        setButtonIdle(reg.button, reg.defaultLabel);
        buttonRegistry.delete(downloadId);
      }
      reportToBackground({
        downloadId,
        itemId,
        status: "canceled",
        progress: 0
      });
    } else if (data.type === "error") {
      console.warn("[TMD] Download failed:", error);
      if (reg) {
        setButtonError(reg.button, error || "Download failed");
        buttonRegistry.delete(downloadId);
      }
      reportToBackground({
        downloadId,
        itemId,
        status: "error",
        progress: 0,
        error: error || "Download failed"
      });
    }
  });

  // Listen to popup / background messages
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || typeof msg.type !== "string") return false;

    if (msg.type === "get_status") {
      const version = detectClientVersion();
      const buttons = document.querySelectorAll(".tmd-download-btn");
      sendResponse({ version, mediaCount: buttons.length });
      return false;
    }

    if (msg.type === "cancel_download") {
      postToPage("cancel", { downloadId: msg.downloadId });
      sendResponse({ ok: true });
      return false;
    }

    if (msg.type === "download_all_visible") {
      const buttons = Array.from(
        document.querySelectorAll(".tmd-single-btn, .tmd-album-btn, .tmd-audio-btn")
      );
      sendResponse({ ok: true, count: buttons.length });
      (async () => {
        for (const btn of buttons) {
          if (!btn.disabled) {
            btn.click();
            await sleep(300);
          }
        }
      })();
      return false;
    }

    return false;
  });

  const domObserver = new MutationObserver(() => {
    if (window.location.href !== lastUrl) {
      lastUrl = window.location.href;
    }
    scheduleScan();
  });

  domObserver.observe(document.body, {
    childList: true,
    subtree: true
  });

  // Initial scan after Telegram Web hydrates
  setTimeout(scanPage, 1200);
})();
