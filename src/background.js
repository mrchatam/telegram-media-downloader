const downloadsById = new Map();
const MAX_HISTORY = 50;

function pruneHistory() {
  if (downloadsById.size <= MAX_HISTORY) return;
  const entries = Array.from(downloadsById.entries());
  for (const [id, item] of entries) {
    if (downloadsById.size <= MAX_HISTORY) break;
    if (item.status !== "downloading" && item.status !== "queued") {
      downloadsById.delete(id);
    }
  }
}

function updateBadge() {
  let active = 0;
  for (const item of downloadsById.values()) {
    if (item.status === "downloading" || item.status === "queued") {
      active++;
    }
  }
  chrome.action.setBadgeText({ text: active > 0 ? String(active) : "" }).catch(() => {});
  if (active > 0) {
    chrome.action.setBadgeBackgroundColor({ color: "#c026d3" }).catch(() => {});
  }
}

function broadcastState() {
  const list = Array.from(downloadsById.values()).sort((a, b) => b.updatedAt - a.updatedAt);
  chrome.runtime.sendMessage({ type: "downloads_state", downloads: list }).catch(() => {});
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== "string") return false;

  switch (msg.type) {
    case "download_upsert": {
      const item = msg.item;
      if (!item?.downloadId) return false;
      const prev = downloadsById.get(item.downloadId) || {};
      downloadsById.set(item.downloadId, {
        ...prev,
        ...item,
        tabId: sender?.tab?.id ?? prev.tabId ?? null,
        updatedAt: Date.now()
      });
      pruneHistory();
      updateBadge();
      broadcastState();
      sendResponse({ ok: true });
      return false;
    }

    case "get_downloads": {
      const list = Array.from(downloadsById.values()).sort((a, b) => b.updatedAt - a.updatedAt);
      sendResponse({ downloads: list });
      return false;
    }

    case "clear_completed": {
      for (const [id, item] of downloadsById.entries()) {
        if (item.status !== "downloading" && item.status !== "queued") {
          downloadsById.delete(id);
        }
      }
      updateBadge();
      broadcastState();
      sendResponse({ ok: true });
      return false;
    }

    case "cancel_download_from_popup": {
      const entry = downloadsById.get(msg.downloadId);
      if (entry?.tabId != null) {
        chrome.tabs
          .sendMessage(entry.tabId, { type: "cancel_download", downloadId: msg.downloadId })
          .catch(() => {});
      }
      sendResponse({ ok: true });
      return false;
    }

    default:
      return false;
  }
});
