const endpoint = "http://127.0.0.1:9222/json";
const pageUrlPart = "/edge-smoke.html";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function getPageTarget() {
  for (let i = 0; i < 50; i += 1) {
    try {
      const targets = await fetch(endpoint).then((response) => response.json());
      const target = targets.find((item) => item.type === "page" && item.url.includes(pageUrlPart));
      if (target?.webSocketDebuggerUrl) return target;
    } catch (_) {
      // Edge may still be starting.
    }
    await sleep(200);
  }
  throw new Error("Cannot find Edge smoke test page via CDP");
}

function connectCdp(url) {
  const socket = new WebSocket(url);
  let nextId = 1;
  const pending = new Map();

  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new Error(message.error.message));
      else resolve(message.result);
    }
  });

  return new Promise((resolve, reject) => {
    socket.addEventListener("open", () => {
      resolve({
        send(method, params = {}) {
          const id = nextId;
          nextId += 1;
          socket.send(JSON.stringify({ id, method, params }));
          return new Promise((innerResolve, innerReject) => pending.set(id, { resolve: innerResolve, reject: innerReject }));
        },
        close() {
          socket.close();
        }
      });
    });
    socket.addEventListener("error", reject);
  });
}

async function evaluate(client, expression) {
  const result = await client.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.text || "Runtime evaluation failed");
  }
  return result.result.value;
}

const target = await getPageTarget();
const client = await connectCdp(target.webSocketDebuggerUrl);

try {
  await client.send("Runtime.enable");
  await client.send("Page.enable");
  await sleep(1000);

  const boot = await evaluate(client, `({
    hasHighlightLayer: Boolean(document.querySelector('.whl-layer')),
    hasPenLayer: Boolean(document.querySelector('.whl-pen-layer')),
    url: location.href
  })`);

  const selectionResult = await evaluate(client, `new Promise((resolve) => {
    const textNode = document.querySelector('#math').firstChild;
    const text = textNode.nodeValue;
    const start = text.indexOf('E = mc²');
    const end = text.indexOf('∀x∈ℝ') + '∀x∈ℝ'.length;
    const range = document.createRange();
    range.setStart(textNode, start);
    range.setEnd(textNode, end);
    const selection = getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    setTimeout(() => resolve({
      highlightCount: document.querySelectorAll('.whl-highlight').length,
      storedKeys: null
    }), 500);
  })`);

  const persisted = await evaluate(client, `new Promise((resolve) => {
    chrome.storage.local.get(null, (value) => {
      const key = Object.keys(value).find((item) => item.startsWith('whl:page:'));
      resolve({
        hasPageKey: Boolean(key),
        highlights: key ? value[key].highlights.length : 0,
        savedText: key ? value[key].highlights[0]?.text : null
      });
    });
  })`);

  const eraseResult = await evaluate(client, `new Promise((resolve) => {
    document.body.classList.add('whl-eraser-active');
    const item = document.querySelector('.whl-highlight');
    item?.click();
    setTimeout(() => resolve({ highlightCount: document.querySelectorAll('.whl-highlight').length }), 500);
  })`);

  console.log(JSON.stringify({ boot, selectionResult, persisted, eraseResult }, null, 2));
} finally {
  client.close();
}
