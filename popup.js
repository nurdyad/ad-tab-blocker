const globalToggle = document.getElementById("globalToggle");
const siteToggle = document.getElementById("siteToggle");
const siteHost = document.getElementById("siteHost");
const siteStatus = document.getElementById("siteStatus");
const logList = document.getElementById("logList");
const refreshLogsButton = document.getElementById("refreshLogs");
const clearLogsButton = document.getElementById("clearLogs");
const openOptionsLink = document.getElementById("openOptions");

let currentHost = "";

void initPopup();

async function initPopup() {
  bindEvents();

  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  currentHost = hostFromUrl(activeTab?.url || "");

  const state = await sendMessage({
    type: "ATB_GET_STATE",
    host: currentHost,
  });

  renderState(state);
  await refreshLogs();

  window.setInterval(() => {
    void refreshLogs();
  }, 2000);
}

function bindEvents() {
  globalToggle.addEventListener("change", async () => {
    await sendMessage({
      type: "ATB_SET_GLOBAL_ENABLED",
      enabled: globalToggle.checked,
    });

    const state = await sendMessage({
      type: "ATB_GET_STATE",
      host: currentHost,
    });
    renderState(state);
  });

  siteToggle.addEventListener("change", async () => {
    if (!currentHost) {
      return;
    }

    await sendMessage({
      type: "ATB_SET_SITE_OVERRIDE",
      host: currentHost,
      enabled: siteToggle.checked,
    });

    const state = await sendMessage({
      type: "ATB_GET_STATE",
      host: currentHost,
    });
    renderState(state);
  });

  refreshLogsButton.addEventListener("click", () => {
    void refreshLogs();
  });

  clearLogsButton.addEventListener("click", async () => {
    await sendMessage({ type: "ATB_CLEAR_LOGS" });
    await refreshLogs();
  });

  openOptionsLink.addEventListener("click", (event) => {
    event.preventDefault();
    chrome.runtime.openOptionsPage();
  });
}

function renderState(state) {
  globalToggle.checked = Boolean(state.globalEnabled);

  if (!currentHost) {
    siteHost.textContent = "Not a web page";
    siteToggle.checked = false;
    siteToggle.disabled = true;
    siteStatus.textContent = "Open a regular website tab to set per-site protection.";
    return;
  }

  siteHost.textContent = currentHost;
  siteToggle.disabled = false;
  siteToggle.checked = Boolean(state.siteEnabled);

  if (!state.globalEnabled) {
    siteStatus.textContent = "Global protection is off.";
    return;
  }

  if (state.siteOverride === null) {
    siteStatus.textContent = state.domainListed
      ? "Enabled by domain list."
      : "Disabled because this host is not in your protected domain list.";
    return;
  }

  siteStatus.textContent = state.siteEnabled
    ? "Enabled by per-site override."
    : "Disabled by per-site override.";
}

async function refreshLogs() {
  const response = await sendMessage({ type: "ATB_GET_LOGS" });
  renderLogs(Array.isArray(response.logs) ? response.logs : []);
}

function renderLogs(logs) {
  logList.textContent = "";

  if (logs.length === 0) {
    const emptyItem = document.createElement("li");
    emptyItem.className = "muted";
    emptyItem.textContent = "No blocked events yet.";
    logList.appendChild(emptyItem);
    return;
  }

  for (const entry of logs) {
    const row = document.createElement("li");
    row.className = "log-item";

    const time = new Date(entry.timestamp).toLocaleTimeString();
    const type = entry.type || "blocked";
    const target = entry.targetUrl || "(no target URL)";

    row.textContent = `${time}  ${type}  ${target}`;
    row.title = `Tab ${entry.sourceTabId ?? "?"} • ${entry.reason || "no reason"}`;

    logList.appendChild(row);
  }
}

function hostFromUrl(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return "";
    }
    return parsed.hostname.toLowerCase();
  } catch (error) {
    return "";
  }
}

function sendMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }

      if (response && response.ok === false) {
        reject(new Error(response.error || "Unknown extension error"));
        return;
      }

      resolve(response || { ok: true });
    });
  });
}
