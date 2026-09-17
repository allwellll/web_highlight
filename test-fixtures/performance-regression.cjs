const fs = require("node:fs");
const vm = require("node:vm");
const assert = require("node:assert/strict");

const contentSource = fs.readFileSync("src/content/content.js", "utf8");
const limitMatch = contentSource.match(/const MINIMAP_MAX_RENDERED_DOTS = \d+;/);
const compactMatch = contentSource.match(/function compactMinimapDots\(dots, scrollHeight\) \{[\s\S]*?\n\}/);
const dotMatch = contentSource.match(/function compactMinimapDot\(dot, scrollHeight\) \{[\s\S]*?\n\}/);

assert.ok(limitMatch, "minimap render limit should exist");
assert.ok(compactMatch, "compactMinimapDots should exist");
assert.ok(dotMatch, "compactMinimapDot should exist");

const context = {};
vm.createContext(context);
vm.runInContext(
  `${limitMatch[0]}\n${compactMatch[0]}\n${dotMatch[0]}\nthis.compactMinimapDots = compactMinimapDots;`,
  context
);

const denseDots = Array.from({ length: 1000 }, (_, index) => ({
  id: String(index),
  top: index * 10,
  color: "#f0d86a"
}));
const compactedDots = context.compactMinimapDots(denseDots, 10000);

assert.ok(compactedDots.length <= 300);
assert.equal(new Set(compactedDots.map((dot) => dot.minimapBucket)).size, compactedDots.length);
assert.equal(context.compactMinimapDots(denseDots.slice(0, 100), 10000).length, 100);

assert.match(contentSource, /if \(isViewportScrollTarget\(event\?\.target\)\) return;/);
assert.match(contentSource, /debugLog\("menu rendered", \(\) => \(\{/);
assert.doesNotMatch(contentSource, /estimateJsonSize/);
assert.match(contentSource, /payload = isEmptyPageData\(pageData\) \? pageData : undefined/);

console.log("performance regression passed");
