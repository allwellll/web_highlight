const fs = require("node:fs");
const assert = require("node:assert/strict");

const contentSource = fs.readFileSync("src/content/content.js", "utf8");
const popupSource = fs.readFileSync("src/popup/popup.js", "utf8");
const popupHtml = fs.readFileSync("src/popup/popup.html", "utf8");
const backgroundSource = fs.readFileSync("src/background/service_worker.js", "utf8");

assert.match(popupHtml, /id="uploadNow"[^>]*>立即上传</);
assert.match(popupHtml, /id="renderNow"[^>]*>立即渲染</);
assert.match(popupSource, /type: "WHL_UPLOAD_NOW"/);
assert.match(popupSource, /type: "WHL_RENDER_NOW"/);
assert.match(contentSource, /function uploadPageDataNow\(\)/);
assert.match(contentSource, /function renderPageDataNow\(\)/);
assert.match(contentSource, /applyRemotePageData\(true\)/);
assert.match(backgroundSource, /message\.type === "WHL_SAVE_REMOTE_NOW"/);
assert.match(backgroundSource, /function saveRemoteNow\(pageUrl, payload\)/);

console.log("manual sync actions regression passed");
