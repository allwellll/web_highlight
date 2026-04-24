const modeButtons = [...document.querySelectorAll("[data-mode]")];
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
const clearPage = document.querySelector("#clearPage");
const cleanupLocal = document.querySelector("#cleanupLocal");
const saveSync = document.querySelector("#saveSync");

let currentState = {};

init();

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) {
    setStatus("未找到当前标签页");
    return;
  }

  chrome.tabs.sendMessage(tab.id, { type: "WHL_GET_STATUS" }, (response) => {
    if (chrome.runtime.lastError || !response?.ok) {
      setStatus("当前页面暂不支持标注，请刷新后重试");
      return;
    }
    currentState = response.state;
    syncStateToForm(response.state);
    renderCounts(response.counts);
  });

  chrome.runtime.sendMessage({ type: "WHL_GET_SYNC_CONFIG" }, (config) => {
    inputs.davUrl.value = config?.davUrl || "";
    inputs.username.value = config?.username || "";
    inputs.password.value = config?.password || "";
    inputs.enabled.checked = Boolean(config?.enabled);
  });

  modeButtons.forEach((button) => {
    button.addEventListener("click", () => updateContentState(tab.id, { mode: button.dataset.mode }));
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

function updateContentState(tabId, patch) {
  currentState = { ...currentState, ...patch };
  chrome.tabs.sendMessage(tabId, { type: "WHL_SET_MODE", state: currentState }, (response) => {
    if (!response?.ok) {
      setStatus("工具状态更新失败");
      return;
    }
    currentState = response.state;
    syncStateToForm(response.state);
    setStatus("工具已切换");
  });
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
  });
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

function setStatus(message) {
  status.textContent = message;
}
