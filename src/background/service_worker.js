const DEFAULT_DAV_URL = "https://dav.jianguoyun.com/dav/web-highlight";

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || !message.type) return false;

  if (message.type === "WHL_GET_SYNC_CONFIG") {
    getSyncConfig().then(sendResponse);
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
  if (!isConfigReady(config)) return { ok: false, skipped: true, reason: "sync-disabled" };

  try {
    const response = await fetch(await remoteFileUrl(config, pageUrl), {
      method: "GET",
      headers: authHeaders(config)
    });
    if (response.status === 404) return { ok: true, payload: null };
    if (!response.ok) throw new Error(`WebDAV load failed: ${response.status}`);
    return { ok: true, payload: await response.json() };
  } catch (error) {
    return { ok: false, reason: error.message };
  }
}

async function scheduleRemoteSave(pageUrl, payload) {
  const config = await getSyncConfig();
  if (!isConfigReady(config)) return { ok: false, skipped: true, reason: "sync-disabled" };

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
  } catch (error) {
    console.warn("[Web Highlight] Remote save failed", error);
  }
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
