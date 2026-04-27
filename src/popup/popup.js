const modeButtons = [...document.querySelectorAll("[data-mode]")];
const POPUP_DEBUG_HOSTS = ["ns01.plusai.io"];

const inputs = {
  highlightColor: document.querySelector("#highlightColor"),
  highlightPalette: document.querySelector("#highlightPalette"),
  highlightShortcut: document.querySelector("#highlightShortcut"),
  penColor: document.querySelector("#penColor"),
  penWidth: document.querySelector("#penWidth"),
  davUrl: document.querySelector("#davUrl"),
  username: document.querySelector("#username"),
  password: document.querySelector("#password"),
  enabled: document.querySelector("#enabled")
};
const counts = document.querySelector("#counts");
const status = document.querySelector("#status");
const syncStatus = document.querySelector("#syncStatus");
const clearPage = document.querySelector("#clearPage");
const cleanupLocal = document.querySelector("#cleanupLocal");
const saveSync = document.querySelector("#saveSync");

let currentState = {};

init();

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type !== "WHL_SYNC_STATUS_UPDATED") return false;
  renderSyncStatus();
  return false;
});

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) {
    setStatus("未找到当前标签页");
    return;
  }

  getContentStatus(tab.id);

  chrome.runtime.sendMessage({ type: "WHL_GET_SYNC_CONFIG" }, (config) => {
    inputs.davUrl.value = config?.davUrl || "";
    inputs.username.value = config?.username || "";
    inputs.password.value = config?.password || "";
    inputs.enabled.checked = Boolean(config?.enabled);
  });
  renderSyncStatus(tab.url);

  modeButtons.forEach((button) => {
    button.addEventListener("click", () => updateContentState(tab.id, { mode: button.dataset.mode, modePinned: true }));
  });

  for (const name of ["highlightColor", "highlightShortcut", "penColor", "penWidth"]) {
    inputs[name].addEventListener("input", () => updateContentState(tab.id, { [name]: inputs[name].value }));
  }

  inputs.highlightPalette.addEventListener("change", () => {
    updateContentState(tab.id, { highlightPalette: parsePalette(inputs.highlightPalette.value) });
  });

  clearPage.addEventListener("click", () => {
    if (!confirm("确定清空当前网页的所有高亮和笔迹吗？")) return;
    chrome.tabs.sendMessage(tab.id, { type: "WHL_CLEAR_PAGE" }, (response) => {
      if (response?.ok) renderCounts(response.counts);
      setStatus(response?.ok ? "已清空当前网页标注" : "清空失败");
    });
  });

  cleanupLocal.addEventListener("click", () => {
    chrome.tabs.sendMessage(tab.id, { type: "WHL_CLEANUP_LOCAL" }, (response) => {
      if (!response?.ok) {
        setStatus("清理失败，请刷新页面后重试");
        return;
      }
      setStatus(`已清理 ${response.removed || 0} 个过期页面，剩余 ${response.remaining || 0} 个页面`);
    });
  });

  saveSync.addEventListener("click", saveSyncConfig);
}

async function getContentStatus(tabId) {
  popupDebugLog("get status", { tabId });
  const response = await sendTabMessage(tabId, { type: "WHL_GET_STATUS" });
  popupDebugLog("get status response", { tabId, ok: Boolean(response?.ok), state: response?.state });
  if (!response?.ok) {
    popupDebugLog("content missing, injecting", { tabId });
    const injected = await injectContentScript(tabId);
    popupDebugLog("inject result", { tabId, injected });
    if (!injected) {
      setStatus("当前页面暂不支持标注，请刷新后重试");
      return;
    }
    const retry = await sendTabMessage(tabId, { type: "WHL_GET_STATUS" });
    if (!retry?.ok) {
      setStatus("当前页面暂不支持标注，请刷新后重试");
      return;
    }
    currentState = retry.state;
    syncStateToForm(retry.state);
    renderCounts(retry.counts);
    setStatus(statusText(retry.state, "标注工具已就绪"));
    return;
  }
  currentState = response.state;
  syncStateToForm(response.state);
  renderCounts(response.counts);
  setStatus(statusText(response.state, "标注工具已就绪"));
}

async function updateContentState(tabId, patch) {
  currentState = { ...currentState, ...patch };
  popupDebugLog("set mode/state", { tabId, patch, currentState });
  let response = await sendTabMessage(tabId, { type: "WHL_SET_MODE", state: currentState });
  if (!response?.ok && await injectContentScript(tabId)) {
    response = await sendTabMessage(tabId, { type: "WHL_SET_MODE", state: currentState });
  }
  if (!response?.ok) {
    setStatus("工具状态更新失败，请刷新页面后重试");
    return;
  }
  currentState = response.state;
  syncStateToForm(response.state);
  setStatus(statusText(response.state, "工具已切换"));
}

function sendTabMessage(tabId, message) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      resolve(chrome.runtime.lastError ? null : response);
    });
  });
}

async function injectContentScript(tabId) {
  try {
    await chrome.scripting.insertCSS({ target: { tabId }, files: ["src/content/content.css"] });
    await chrome.scripting.executeScript({ target: { tabId }, files: ["src/content/content.js"] });
    return true;
  } catch (error) {
    popupDebugLog("inject failed", { tabId, message: error?.message });
    return false;
  }
}

async function popupDebugLog(message, data = {}) {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const host = tab?.url ? new URL(tab.url).hostname : "";
    if (!POPUP_DEBUG_HOSTS.includes(host)) return;
    console.info(`[WHL POPUP][${new Date().toISOString()}] ${message}`, data);
  } catch (_error) {
  }
}

function saveSyncConfig() {
  const config = {
    davUrl: inputs.davUrl.value,
    username: inputs.username.value,
    password: inputs.password.value,
    enabled: inputs.enabled.checked
  };
  chrome.runtime.sendMessage({ type: "WHL_SET_SYNC_CONFIG", config }, (response) => {
    setStatus(response?.ok ? "同步设置已保存" : "同步设置保存失败");
    renderSyncStatus();
  });
}

async function renderSyncStatus(url) {
  const pageUrl = url || (await activeTabUrl());
  chrome.runtime.sendMessage({ type: "WHL_GET_SYNC_STATUS", url: pageUrl }, (sync) => {
    syncStatus.textContent = formatSyncStatus(sync);
  });
}

async function activeTabUrl() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab?.url || "";
}

function syncStateToForm(state) {
  inputs.highlightColor.value = state.highlightColor || "#ffe600";
  inputs.highlightPalette.value = normalizePalette(state.highlightPalette).join(",");
  inputs.highlightShortcut.value = state.highlightShortcut || "Alt+H";
  inputs.penColor.value = state.penColor || "#e53935";
  inputs.penWidth.value = state.penWidth || 4;
  modeButtons.forEach((button) => button.classList.toggle("active", button.dataset.mode === state.mode));
}

function parsePalette(value) {
  return value.split(/[，,\s]+/).map((item) => item.trim()).filter(isHexColor).slice(0, 8);
}

function normalizePalette(value) {
  return Array.isArray(value) && value.length ? value : ["#ffe600", "#7cff7c", "#74c0fc", "#ffadad"];
}

function isHexColor(value) {
  return /^#[0-9a-f]{6}$/i.test(value);
}

function renderCounts(value = {}) {
  counts.textContent = `当前网页：${value.highlights || 0} 个高亮，${value.underlines || 0} 条划线，${value.strokes || 0} 条笔迹`;
}

function formatSyncStatus(sync) {
  if (!sync) return "同步状态：暂无当前网页同步记录";
  const operation = sync.operation === "load" ? "拉取" : "上传";
  const statusTextMap = {
    queued: "排队中",
    success: "成功",
    error: "失败",
    skipped: "已跳过"
  };
  const time = sync.timestamp ? new Date(sync.timestamp).toLocaleString() : "未知时间";
  const counts = sync.counts || {};
  const reason = sync.reason && !["saved", "loaded", "queued"].includes(sync.reason) ? `，原因：${sync.reason}` : "";
  return `同步状态：${operation}${statusTextMap[sync.status] || sync.status || "未知"}，时间：${time}，记录：${counts.total || 0} 条（高亮 ${counts.highlights || 0}，划线 ${counts.underlines || 0}，笔迹 ${counts.strokes || 0}）${reason}`;
}

function statusText(state, prefix) {
  if (state?.mode === "browse") return `${prefix}：浏览模式下选中文字不会弹菜单`;
  if (state?.mode === "highlight") return `${prefix}：高亮模式，选中文字会弹颜色菜单`;
  if (state?.mode === "underline") return `${prefix}：划线模式，选中文字会弹颜色菜单`;
  if (state?.mode === "pen") return `${prefix}：画笔模式，可拖动绘制`;
  if (state?.mode === "eraser") return `${prefix}：删除模式，可点击标注删除`;
  return prefix;
}

function setStatus(message) {
  status.textContent = message;
}
