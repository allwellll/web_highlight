const DEFAULT_DAV_URL = "https://dav.jianguoyun.com/dav/web-highlight";
const SYNC_STATUS_KEY = "whlSyncStatus";

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || !message.type) return false;

  if (message.type === "WHL_GET_SYNC_CONFIG") {
    getSyncConfig().then(sendResponse);
    return true;
  }

  if (message.type === "WHL_GET_SYNC_STATUS") {
    getSyncStatus(message.url).then(sendResponse);
    return true;
  }

  if (message.type === "WHL_SET_SYNC_CONFIG") {
    setSyncConfig(message.config).then(sendResponse);
    return true;
  }

  if (message.type === "WHL_LOAD_REMOTE") {
    loadRemoteAnnotations(message.url).then(sendResponse);
    return true;
  }

  if (message.type === "WHL_SAVE_REMOTE") {
    scheduleRemoteSave(message.url, message.payload).then(sendResponse);
    return true;
  }

  return false;
});

async function getSyncConfig() {
  const stored = await chrome.storage.local.get("whlSyncConfig");
  return {
    davUrl: DEFAULT_DAV_URL,
    username: "",
    password: "",
    enabled: false,
    ...(stored.whlSyncConfig || {})
  };
}

async function setSyncConfig(config) {
  const nextConfig = {
    davUrl: normalizeDavUrl(config?.davUrl || DEFAULT_DAV_URL),
    username: String(config?.username || "").trim(),
    password: String(config?.password || ""),
    enabled: Boolean(config?.enabled)
  };
  await chrome.storage.local.set({ whlSyncConfig: nextConfig });
  return { ok: true, config: nextConfig };
}

async function loadRemoteAnnotations(pageUrl) {
  const config = await getSyncConfig();
  if (!isConfigReady(config)) {
    await updateSyncStatus(pageUrl, "load", "skipped", "sync-disabled", null);
    return { ok: false, skipped: true, reason: "sync-disabled" };
  }

  try {
    const response = await fetch(await remoteFileUrl(config, pageUrl), {
      method: "GET",
      headers: authHeaders(config)
    });
    if (response.status === 404) {
      await updateSyncStatus(pageUrl, "load", "success", "remote-empty", null);
      return { ok: true, payload: null };
    }
    if (!response.ok) throw new Error(`WebDAV load failed: ${response.status}`);
    const payload = await response.json();
    await updateSyncStatus(pageUrl, "load", "success", "loaded", payload);
    return { ok: true, payload };
  } catch (error) {
    await updateSyncStatus(pageUrl, "load", "error", error.message, null);
    return { ok: false, reason: error.message };
  }
}

async function scheduleRemoteSave(pageUrl, payload) {
  const config = await getSyncConfig();
  if (!isConfigReady(config)) {
    await updateSyncStatus(pageUrl, "save", "skipped", "sync-disabled", payload);
    return { ok: false, skipped: true, reason: "sync-disabled" };
  }

  await updateSyncStatus(pageUrl, "save", "queued", "queued", payload);
  saveRemoteAnnotations(config, pageUrl, payload);
  return { ok: true, queued: true };
}

async function saveRemoteAnnotations(config, pageUrl, payload) {
  try {
    await ensureRemoteDirectory(config);
    const response = await fetch(await remoteFileUrl(config, pageUrl), {
      method: "PUT",
      headers: {
        ...authHeaders(config),
        "Content-Type": "application/json; charset=utf-8"
      },
      body: JSON.stringify(payload)
    });
    if (!response.ok) throw new Error(`WebDAV save failed: ${response.status}`);
    await updateSyncStatus(pageUrl, "save", "success", "saved", payload);
  } catch (error) {
    await updateSyncStatus(pageUrl, "save", "error", error.message, payload);
    console.warn("[Web Highlight] Remote save failed", error);
  }
}

async function getSyncStatus(pageUrl) {
  const stored = await chrome.storage.local.get(SYNC_STATUS_KEY);
  const status = normalizeSyncStatus(stored[SYNC_STATUS_KEY]);
  return pageUrl ? status.pages[pageUrl] || null : status.latest || null;
}

async function updateSyncStatus(pageUrl, operation, status, reason, payload) {
  const stored = await chrome.storage.local.get(SYNC_STATUS_KEY);
  const current = normalizeSyncStatus(stored[SYNC_STATUS_KEY]);
  const next = {
    url: pageUrl,
    operation,
    status,
    reason,
    timestamp: Date.now(),
    counts: countPayloadRecords(payload)
  };
  current.latest = next;
  if (pageUrl) current.pages[pageUrl] = next;
  await chrome.storage.local.set({ [SYNC_STATUS_KEY]: current });
  const messageResult = chrome.runtime.sendMessage({ type: "WHL_SYNC_STATUS_UPDATED", status: next });
  messageResult?.catch?.(() => {});
}

function normalizeSyncStatus(value) {
  return { latest: value?.latest || null, pages: { ...(value?.pages || {}) } };
}

function countPayloadRecords(payload) {
  const highlights = Array.isArray(payload?.highlights) ? payload.highlights : [];
  const strokes = Array.isArray(payload?.strokes) ? payload.strokes : [];
  const highlighters = highlights.filter((item) => item?.type !== "underline").length;
  const underlines = highlights.filter((item) => item?.type === "underline").length;
  return {
    total: highlights.length + strokes.length,
    highlights: highlighters,
    underlines,
    strokes: strokes.length
  };
}

async function ensureRemoteDirectory(config) {
  const response = await fetch(config.davUrl, {
    method: "MKCOL",
    headers: authHeaders(config)
  });
  if (![201, 405, 301, 302].includes(response.status)) {
    console.warn("[Web Highlight] MKCOL returned", response.status);
  }
}

async function remoteFileUrl(config, pageUrl) {
  return `${config.davUrl}/${await digestUrl(pageUrl)}.json`;
}

async function digestUrl(pageUrl) {
  const bytes = new TextEncoder().encode(pageUrl);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function authHeaders(config) {
  return { Authorization: `Basic ${btoa(`${config.username}:${config.password}`)}` };
}

function isConfigReady(config) {
  return Boolean(config.enabled && config.davUrl && config.username && config.password);
}

function normalizeDavUrl(url) {
  return String(url).trim().replace(/\/+$/, "") || DEFAULT_DAV_URL;
}
