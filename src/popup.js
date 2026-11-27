const statusText = document.getElementById("status-text");
const btnBatch = document.getElementById("btn-batch");
const btnClear = document.getElementById("btn-clear");
const listEl = document.getElementById("downloads-list");

let activeTabId = null;

function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function renderDownloads(downloads) {
  if (!downloads || downloads.length === 0) {
    listEl.innerHTML =
      '<div class="empty">No downloads yet. Click Download on any media in Telegram Web.</div>';
    return;
  }

  listEl.innerHTML = "";
  for (const item of downloads) {
    const row = document.createElement("div");
    row.className = "dl-item";

    const top = document.createElement("div");
    top.className = "dl-top";

    const name = document.createElement("div");
    name.className = "dl-name";
    name.textContent = item.filename || item.mediaType || "Telegram media";
    name.title = name.textContent;

    const meta = document.createElement("div");
    meta.className = "dl-meta";

    const pct = Math.min(100, Math.max(0, Math.round(item.progress || 0)));
    const statusLabel = document.createElement("span");
    if (item.status === "done") {
      statusLabel.textContent = formatBytes(item.sizeBytes) || "Done";
    } else if (item.status === "error") {
      statusLabel.textContent = "Failed";
    } else if (item.status === "canceled") {
      statusLabel.textContent = "Canceled";
    } else {
      statusLabel.textContent = `${pct}%`;
    }
    meta.appendChild(statusLabel);

    if (item.status === "downloading" || item.status === "queued") {
      const cancelBtn = document.createElement("button");
      cancelBtn.className = "dl-cancel";
      cancelBtn.textContent = "✕";
      cancelBtn.title = "Cancel download";
      cancelBtn.addEventListener("click", () => {
        chrome.runtime.sendMessage({
          type: "cancel_download_from_popup",
          downloadId: item.downloadId
        });
      });
      meta.appendChild(cancelBtn);
    }

    top.appendChild(name);
    top.appendChild(meta);
    row.appendChild(top);

    const bar = document.createElement("div");
    bar.className = "dl-bar";
    const fill = document.createElement("div");
    fill.className = "dl-bar-fill";
    fill.style.width = `${item.status === "done" ? 100 : pct}%`;
    bar.appendChild(fill);
    row.appendChild(bar);

    if (item.status === "error" && item.error) {
      const errEl = document.createElement("div");
      errEl.className = "dl-error";
      errEl.textContent = item.error;
      row.appendChild(errEl);
    }

    listEl.appendChild(row);
  }
}

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id && tab.url?.startsWith("https://web.telegram.org/")) {
    activeTabId = tab.id;
    try {
      const res = await chrome.tabs.sendMessage(tab.id, { type: "get_status" });
      if (res?.version) {
        const label = res.version === "a" ? "Telegram Web A" : "Telegram Web K";
        statusText.textContent = `${label} • ${res.mediaCount || 0} media visible`;
        btnBatch.disabled = (res.mediaCount || 0) === 0;
      } else {
        statusText.textContent = "Open a chat on web.telegram.org";
      }
    } catch {
      statusText.textContent = "Reload web.telegram.org tab";
    }
  } else {
    statusText.textContent = "Open web.telegram.org to download";
  }

  chrome.runtime.sendMessage({ type: "get_downloads" }, (res) => {
    renderDownloads(res?.downloads || []);
  });
}

btnBatch.addEventListener("click", async () => {
  if (!activeTabId) return;
  btnBatch.disabled = true;
  try {
    await chrome.tabs.sendMessage(activeTabId, { type: "download_all_visible" });
  } finally {
    setTimeout(() => {
      btnBatch.disabled = false;
    }, 600);
  }
});

btnClear.addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "clear_completed" }, () => {
    chrome.runtime.sendMessage({ type: "get_downloads" }, (res) => {
      renderDownloads(res?.downloads || []);
    });
  });
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === "downloads_state") {
    renderDownloads(msg.downloads || []);
  }
});

init();
