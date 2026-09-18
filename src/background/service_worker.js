const DEFAULT_DAV_URL = "https://dav.jianguoyun.com/dav/web-highlight";
const SYNC_STATUS_KEY = "whlSyncStatus";
const PAGE_STORAGE_PREFIX = "whl:page:";
const REMOTE_SAVE_DELAY_MS = 1500;

let syncConfigCache = null;
const digestCache = new Map();
const remoteFileUrlCache = new Map();
const ensuredRemoteDirectories = new Set();
const pendingRemoteSaves = new Map();
const remoteSaveChains = new Map();

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
  if (syncConfigCache) return syncConfigCache;
  const stored = await chrome.storage.local.get("whlSyncConfig");
  syncConfigCache = {
    davUrl: DEFAULT_DAV_URL,
    username: "",
    password: "",
    enabled: false,
    ...(stored.whlSyncConfig || {})
  };
  return syncConfigCache;
}

async function setSyncConfig(config) {
  const nextConfig = {
    davUrl: normalizeDavUrl(config?.davUrl || DEFAULT_DAV_URL),
    username: String(config?.username || "").trim(),
    password: String(config?.password || ""),
    enabled: Boolean(config?.enabled)
  };
  await chrome.storage.local.set({ whlSyncConfig: nextConfig });
  cancelPendingRemoteSaves();
  syncConfigCache = nextConfig;
  remoteFileUrlCache.clear();
  ensuredRemoteDirectories.clear();
  return { ok: true, config: nextConfig };
}

async function loadRemoteAnnotations(pageUrl) {
  const config = await getSyncConfig();
  if (!isConfigReady(config)) {
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
    return { ok: false, skipped: true, reason: "sync-disabled" };
  }

  const resolvedPayload = payload || await loadLocalPageData(pageUrl);
  if (!resolvedPayload) return { ok: false, skipped: true, reason: "local-empty" };

  const previous = pendingRemoteSaves.get(pageUrl);
  if (previous) clearTimeout(previous.timer);
  const pending = {
    config,
    payload: resolvedPayload,
    timer: setTimeout(() => flushRemoteSave(pageUrl).catch((error) => {
      console.warn("[Web Highlight] Queued remote save failed", error);
    }), REMOTE_SAVE_DELAY_MS)
  };
  pendingRemoteSaves.set(pageUrl, pending);
  return { ok: true, queued: true };
}

function cancelPendingRemoteSaves() {
  for (const pending of pendingRemoteSaves.values()) clearTimeout(pending.timer);
  pendingRemoteSaves.clear();
}

async function flushRemoteSave(pageUrl) {
  const pending = pendingRemoteSaves.get(pageUrl);
  if (!pending) return;
  pendingRemoteSaves.delete(pageUrl);
  const previous = remoteSaveChains.get(pageUrl) || Promise.resolve();
  const current = previous.catch(() => {}).then(async () => {
    await updateSyncStatus(pageUrl, "save", "queued", "queued", pending.payload);
    await saveRemoteAnnotations(pending.config, pageUrl, pending.payload);
  });
  remoteSaveChains.set(pageUrl, current);
  try {
    await current;
  } finally {
    if (remoteSaveChains.get(pageUrl) === current) remoteSaveChains.delete(pageUrl);
  }
}

async function loadLocalPageData(pageUrl) {
  const key = `${PAGE_STORAGE_PREFIX}${pageUrl}`;
  const stored = await chrome.storage.local.get(key);
  return stored[key] || null;
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
  let highlighters = 0;
  let underlines = 0;
  for (const item of highlights) {
    if (item?.type === "underline") underlines += 1;
    else highlighters += 1;
  }
  return {
    total: highlights.length + strokes.length,
    highlights: highlighters,
    underlines,
    strokes: strokes.length
  };
}

async function ensureRemoteDirectory(config) {
  const key = `${config.davUrl}\n${config.username}`;
  if (ensuredRemoteDirectories.has(key)) return;
  const response = await fetch(config.davUrl, {
    method: "MKCOL",
    headers: authHeaders(config)
  });
  if (![201, 405, 301, 302].includes(response.status)) {
    console.warn("[Web Highlight] MKCOL returned", response.status);
    return;
  }
  ensuredRemoteDirectories.add(key);
}

async function remoteFileUrl(config, pageUrl) {
  const key = `${config.davUrl}\n${pageUrl}`;
  if (remoteFileUrlCache.has(key)) return remoteFileUrlCache.get(key);
  const url = `${config.davUrl}/${await digestUrl(pageUrl)}.json`;
  remoteFileUrlCache.set(key, url);
  return url;
}

async function digestUrl(pageUrl) {
  if (digestCache.has(pageUrl)) return digestCache.get(pageUrl);
  const bytes = new TextEncoder().encode(pageUrl);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  const digest = [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  digestCache.set(pageUrl, digest);
  return digest;
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
