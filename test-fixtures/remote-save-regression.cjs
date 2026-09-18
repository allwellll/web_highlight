const fs = require("node:fs");
const vm = require("node:vm");
const assert = require("node:assert/strict");
const { webcrypto } = require("node:crypto");

const source = fs.readFileSync("src/background/service_worker.js", "utf8");

function createContext({ enabled = true, pageData = null } = {}) {
  const pageUrl = "https://example.com/";
  const store = {
    whlSyncConfig: {
      davUrl: "https://dav.example.com/web-highlight",
      username: "user",
      password: "password",
      enabled
    },
    ...(pageData ? { [`whl:page:${pageUrl}`]: pageData } : {})
  };
  const fetchCalls = [];
  const timers = new Map();
  let nextTimer = 0;
  const context = {
    Buffer,
    TextEncoder,
    Uint8Array,
    crypto: webcrypto,
    console,
    Promise,
    Map,
    Date,
    setTimeout(callback) {
      const id = ++nextTimer;
      timers.set(id, callback);
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    btoa(value) {
      return Buffer.from(value).toString("base64");
    },
    fetch: async (url, options = {}) => {
      fetchCalls.push({ url, options });
      if (options.method === "MKCOL") return { ok: false, status: 405 };
      return { ok: true, status: 200, async json() { return null; } };
    },
    chrome: {
      runtime: {
        onMessage: { addListener() {} },
        sendMessage() { return Promise.resolve(); }
      },
      storage: {
        local: {
          async get(keys) {
            if (keys === null || keys === undefined) return { ...store };
            if (typeof keys === "string") return { [keys]: store[keys] };
            if (Array.isArray(keys)) return Object.fromEntries(keys.map((key) => [key, store[key]]));
            return {};
          },
          async set(values) {
            Object.assign(store, values);
          },
          async remove(keys) {
            for (const key of Array.isArray(keys) ? keys : [keys]) delete store[key];
          }
        }
      }
    }
  };
  vm.createContext(context);
  vm.runInContext(source, context);
  return {
    context,
    fetchCalls,
    store,
    timers,
    async schedule(payload) {
      context.__payload = payload;
      return vm.runInContext(`scheduleRemoteSave(${JSON.stringify(pageUrl)}, __payload)`, context);
    },
    async saveNow(payload) {
      context.__payload = payload;
      return vm.runInContext(`saveRemoteNow(${JSON.stringify(pageUrl)}, __payload)`, context);
    },
    async flushNext() {
      const [id, callback] = timers.entries().next().value || [];
      assert.ok(id, "a remote save timer should be pending");
      timers.delete(id);
      await callback();
    }
  };
}

(async () => {
  const disabled = createContext({ enabled: false, pageData: { highlights: [], strokes: [] } });
  const skipped = await disabled.schedule();
  assert.equal(skipped.reason, "sync-disabled");
  assert.equal(disabled.timers.size, 0);
  assert.equal(disabled.fetchCalls.length, 0);
  assert.equal(disabled.store.whlSyncStatus, undefined);

  const disabledImmediate = await disabled.saveNow({ highlights: [], strokes: [] });
  assert.equal(disabledImmediate.reason, "sync-disabled");
  assert.equal(disabled.store.whlSyncStatus.pages["https://example.com/"].status, "skipped");

  const firstPayload = { highlights: [{ id: "first", type: "highlight" }], strokes: [] };
  const latestPayload = { highlights: [{ id: "latest", type: "highlight" }], strokes: [] };
  const enabled = createContext({ pageData: firstPayload });
  await enabled.schedule(firstPayload);
  await enabled.schedule(latestPayload);
  assert.equal(enabled.timers.size, 1);
  await enabled.flushNext();

  assert.equal(enabled.fetchCalls.filter((call) => call.options.method === "MKCOL").length, 1);
  const firstPuts = enabled.fetchCalls.filter((call) => call.options.method === "PUT");
  assert.equal(firstPuts.length, 1);
  assert.equal(JSON.parse(firstPuts[0].options.body).highlights[0].id, "latest");

  const immediatePayload = { highlights: [{ id: "immediate", type: "highlight" }], strokes: [] };
  await enabled.schedule(firstPayload);
  const immediate = await enabled.saveNow(immediatePayload);
  assert.equal(immediate.ok, true);
  assert.equal(enabled.timers.size, 0);
  const immediatePuts = enabled.fetchCalls.filter((call) => call.options.method === "PUT");
  assert.equal(immediatePuts.length, 2);
  assert.equal(JSON.parse(immediatePuts[1].options.body).highlights[0].id, "immediate");

  const emptyPayload = { highlights: [], strokes: [] };
  await enabled.schedule(emptyPayload);
  await enabled.flushNext();
  assert.equal(enabled.fetchCalls.filter((call) => call.options.method === "MKCOL").length, 1);
  const allPuts = enabled.fetchCalls.filter((call) => call.options.method === "PUT");
  assert.equal(allPuts.length, 3);
  assert.deepEqual(JSON.parse(allPuts[2].options.body), emptyPayload);

  console.log("remote save regression passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
