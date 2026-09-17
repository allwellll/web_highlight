const fs = require("node:fs");
const vm = require("node:vm");
const assert = require("node:assert/strict");

const source = fs.readFileSync("src/background/service_worker.js", "utf8");
const constants = source.match(/const DEFAULT_DAV_URL[\s\S]*?const PAGE_STORAGE_PREFIX[^;]+;/)?.[0];
const schedule = source.match(/async function scheduleRemoteSave\(pageUrl\) \{[\s\S]*?\n\}/)?.[0];
const load = source.match(/async function loadLocalPageData\(pageUrl\) \{[\s\S]*?\n\}/)?.[0];

assert.ok(constants, "background constants should exist");
assert.ok(schedule, "scheduleRemoteSave should exist");
assert.ok(load, "loadLocalPageData should exist");

async function createContext(config) {
  const calls = [];
  const context = {
    calls,
    chrome: {
      storage: {
        local: {
          async get(key) {
            calls.push(["get", key]);
            return { [`whl:page:https://example.com/`]: { highlights: [{ type: "highlight" }], strokes: [] } };
          }
        }
      }
    },
    async getSyncConfig() { return config; },
    isConfigReady(value) { return Boolean(value.enabled); },
    async updateSyncStatus(...args) { calls.push(["status", ...args]); },
    async saveRemoteAnnotations(...args) { calls.push(["save", ...args]); }
  };
  vm.createContext(context);
  vm.runInContext(`${constants}\n${schedule}\n${load}\nthis.scheduleRemoteSave = scheduleRemoteSave;`, context);
  return context;
}

(async () => {
  const disabled = await createContext({ enabled: false });
  const skipped = await disabled.scheduleRemoteSave("https://example.com/");
  assert.equal(skipped.reason, "sync-disabled");
  assert.equal(disabled.calls.length, 0);

  const enabled = await createContext({ enabled: true });
  const queued = await enabled.scheduleRemoteSave("https://example.com/");
  assert.equal(queued.queued, true);
  assert.equal(enabled.calls[0][0], "get");
  assert.equal(enabled.calls[1][0], "status");
  assert.equal(enabled.calls[2][0], "save");

  console.log("remote save regression passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
