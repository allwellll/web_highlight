const fs = require("node:fs");
const vm = require("node:vm");
const assert = require("node:assert/strict");

const contentSource = fs.readFileSync("src/content/content.js", "utf8");
const indexStart = contentSource.indexOf("function getKatexRootIndex()");
const indexEnd = contentSource.indexOf("function buildKatexNativeRange", indexStart);
const anchorStart = contentSource.indexOf("function createVisualAnchor(range)");
const anchorEnd = contentSource.indexOf("function visualRangeRoot", anchorStart);

assert.ok(indexStart >= 0 && indexEnd > indexStart, "KaTeX index helpers should exist");
assert.ok(anchorStart >= 0 && anchorEnd > anchorStart, "visual anchor helpers should exist");

const roots = [
  { textContent: "x+y" },
  { textContent: "x+y" },
  { textContent: "a=b" }
];
let queryCount = 0;
const indexContext = {
  document: {
    querySelectorAll(selector) {
      assert.equal(selector, ".katex");
      queryCount += 1;
      return roots;
    }
  },
  katexRootIndexCache: null,
  Map
};
vm.createContext(indexContext);
vm.runInContext(
  `${contentSource.slice(indexStart, indexEnd)}\nthis.getKatexRootIndex = getKatexRootIndex; this.invalidateKatexRootIndex = invalidateKatexRootIndex;`,
  indexContext
);

const firstIndex = indexContext.getKatexRootIndex();
const secondIndex = indexContext.getKatexRootIndex();
assert.equal(queryCount, 1, "repeated lookups should reuse one document scan");
assert.equal(firstIndex, secondIndex);
assert.equal(firstIndex.rootsByText.get("x+y").length, 2);
indexContext.invalidateKatexRootIndex();
indexContext.getKatexRootIndex();
assert.equal(queryCount, 2, "DOM invalidation should rebuild the index once");

let scopedQueryCount = 0;
const textNode = { nodeType: 3 };
const anchorContext = {
  Node: { ELEMENT_NODE: 1 },
  document: { body: {}, documentElement: {} },
  closestRangeElement: () => null,
  getKatexRootIndex: () => ({ roots: [] }),
  katexRootIndexCache: null
};
vm.createContext(anchorContext);
vm.runInContext(
  `${contentSource.slice(anchorStart, anchorEnd)}\nthis.intersectedKatexElement = intersectedKatexElement;`,
  anchorContext
);

const sameNodeRange = { startContainer: textNode, endContainer: textNode };
assert.equal(anchorContext.intersectedKatexElement(sameNodeRange), null);

const scope = {
  querySelector(selector) {
    assert.equal(selector, ".katex");
    scopedQueryCount += 1;
    return null;
  },
  querySelectorAll() {
    throw new Error("ordinary text selection should not enumerate formula nodes");
  }
};
const plainRange = {
  startContainer: {},
  endContainer: {},
  commonAncestorContainer: { nodeType: 1, querySelector: scope.querySelector.bind(scope), querySelectorAll: scope.querySelectorAll }
};
assert.equal(anchorContext.intersectedKatexElement(plainRange), null);
assert.equal(scopedQueryCount, 1);

console.log("KaTeX anchor performance regression passed");
