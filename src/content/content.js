(() => {
if (globalThis.__WHL_CONTENT_LOADED__) return;
globalThis.__WHL_CONTENT_LOADED__ = true;
const STORAGE_PREFIX = "whl:page:";
const STORAGE_INDEX_KEY = "whl:index";
const MAX_LOCAL_PAGES = 500;
const LOCAL_TTL_MS = 180 * 24 * 60 * 60 * 1000;
const PEN_MIN_DISTANCE = 4;
const PEN_MAX_POINTS = 3000;
const ANCHOR_CONTEXT_CHARS = 80;
const MAX_TEXT_CANDIDATES = 80;
const MIN_ANCHOR_SCORE = 64;
const STATE_VERSION = 2;
const DYNAMIC_RENDER_DELAY = 300;
const SCROLL_RENDER_DELAY = 500;
const DEBUG_HOSTS = ["ns01.plusai.io"];
const DEBUG_ENABLED = DEBUG_HOSTS.includes(location.hostname);
const DEFAULT_STATE = {
  mode: "highlight",
  highlightColor: "#ffe600",
  highlightPalette: ["#ffe600", "#7cff7c", "#74c0fc", "#ffadad"],
  highlightShortcut: "Alt+H",
  penColor: "#e53935",
  penWidth: 4,
  modePinned: false,
  version: STATE_VERSION
};

let state = { ...DEFAULT_STATE };
let pageData = emptyPageData();
let highlightLayer;
let penLayer;
let selectionMenu;
let annotationMenu;
let nativeHighlightStyle;
let nativeHighlightNames = [];
let pendingSelection = null;
let currentStroke = null;
let currentPath = null;
let saveTimer = null;
let selectionChangeTimer = null;
let dynamicRenderTimer = null;
let scrollRenderTimer = null;
let isScrolling = false;
let mutationObserver = null;
let resizeObserver = null;
let suppressSelectionMenuUntil = 0;

init();

async function init() {
  createLayers();
  await loadState();
  await cleanupLocalStorage();
  await loadPageData();
  applyModeClass();
  renderAll();
  bindEvents();
  bindDynamicRenderEvents();
  requestRemoteData();
}

function bindEvents() {
  document.addEventListener("mouseup", handleSelection, true);
  document.addEventListener("selectionchange", scheduleSelectionMenu);
  document.addEventListener("pointerdown", handleDocumentPointerDown, true);
  document.addEventListener("mousedown", handleDocumentMouseDown, true);
  document.addEventListener("click", handleDocumentClick, true);
  document.addEventListener("keydown", handleKeydown, true);
  document.addEventListener("visibilitychange", ensureOverlayNodesConnected);
  window.addEventListener("focus", ensureOverlayNodesConnected);
  window.addEventListener("resize", () => scheduleDynamicRender("window resize"));
  document.addEventListener("load", handleResourceLoad, true);
  document.addEventListener("scroll", handleDocumentScroll, true);

  penLayer.addEventListener("pointerdown", startPenStroke);
  penLayer.addEventListener("pointermove", continuePenStroke);
  penLayer.addEventListener("pointerup", finishPenStroke);
  penLayer.addEventListener("pointercancel", cancelPenStroke);
  penLayer.addEventListener("click", handleLayerClick);
  highlightLayer.addEventListener("click", handleLayerClick);

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "WHL_SET_MODE") {
      debugLog("message received: WHL_SET_MODE", { incomingState: message.state, previousMode: state.mode });
      state = { ...state, ...message.state };
      persistState();
      applyModeClass();
      debugLog("mode applied", { mode: state.mode, modePinned: state.modePinned });
      sendResponse({ ok: true, state });
      return false;
    }

    if (message?.type === "WHL_GET_STATUS") {
      debugLog("message received: WHL_GET_STATUS", { mode: state.mode, counts: counts() });
      sendResponse({ ok: true, state, counts: counts() });
      return false;
    }

    if (message?.type === "WHL_CLEAR_PAGE") {
      pageData = emptyPageData();
      renderAll();
      queueSave();
      sendResponse({ ok: true, counts: counts() });
      return false;
    }

    if (message?.type === "WHL_CLEANUP_LOCAL") {
      cleanupLocalStorage(true).then((result) => sendResponse({ ok: true, ...result }));
      return true;
    }

    return false;
  });
}

function bindDynamicRenderEvents() {
  mutationObserver?.disconnect();
  mutationObserver = new MutationObserver(handleDocumentMutations);
  mutationObserver.observe(document.documentElement, {
    childList: true,
    characterData: true,
    subtree: true
  });

  if (!globalThis.ResizeObserver) return;
  resizeObserver?.disconnect();
  resizeObserver = new ResizeObserver(() => scheduleDynamicRender("layout resize"));
  resizeObserver.observe(document.documentElement);
  if (document.body) resizeObserver.observe(document.body);
}

function handleDocumentMutations(records) {
  if (!records.some(isExternalMutation)) return;
  scheduleDynamicRender("dom mutation");
}

function handleResourceLoad(event) {
  if (!event.target?.matches?.("img, iframe, video, audio, source")) return;
  scheduleDynamicRender("resource load");
}

function scheduleDynamicRender(reason) {
  clearTimeout(dynamicRenderTimer);
  dynamicRenderTimer = setTimeout(() => {
    debugLog("dynamic render", { reason });
    renderAll();
  }, DYNAMIC_RENDER_DELAY);
}

function handleDocumentScroll() {
  if (!pageData.highlights.length && !pageData.strokes.length) return;
  isScrolling = true;
  hideScrollableOverlayDuringScroll();
  clearTimeout(scrollRenderTimer);
  scrollRenderTimer = setTimeout(() => {
    isScrolling = false;
    debugLog("scroll render");
    renderAll();
    showScrollableOverlayAfterScroll();
  }, SCROLL_RENDER_DELAY);
}

function hideScrollableOverlayDuringScroll() {
  if (!highlightLayer) return;
  highlightLayer.style.setProperty("visibility", "hidden", "important");
  highlightLayer.style.setProperty("pointer-events", "none", "important");
}

function showScrollableOverlayAfterScroll() {
  if (!highlightLayer || isScrolling) return;
  highlightLayer.style.removeProperty("visibility");
  highlightLayer.style.removeProperty("pointer-events");
}

function isExternalMutation(record) {
  if (isWhlNode(record.target)) return false;
  const addedNodes = [...record.addedNodes];
  const removedNodes = [...record.removedNodes];
  if (removedNodes.some(isOverlayRootNode)) return true;
  const changedNodes = [...addedNodes, ...removedNodes];
  return changedNodes.length === 0 || changedNodes.some((node) => !isWhlNode(node));
}

function isWhlNode(node) {
  if (!node) return false;
  if (node === highlightLayer || node === penLayer || node === selectionMenu || node === annotationMenu || node === nativeHighlightStyle) return true;
  const element = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
  return Boolean(element?.closest?.(".whl-layer, .whl-pen-layer, .whl-selection-menu, .whl-annotation-menu, [data-whl-native-highlights]"));
}

function isOverlayRootNode(node) {
  return node === highlightLayer || node === penLayer || node === selectionMenu || node === annotationMenu || node === nativeHighlightStyle;
}

function createLayers() {
  highlightLayer = document.createElement("div");
  highlightLayer.className = "whl-layer";

  penLayer = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  penLayer.classList.add("whl-pen-layer");

  selectionMenu = document.createElement("div");
  selectionMenu.className = "whl-selection-menu";
  selectionMenu.hidden = true;

  annotationMenu = document.createElement("div");
  annotationMenu.className = "whl-annotation-menu";
  annotationMenu.hidden = true;
  annotationMenu.innerHTML = '<button type="button" data-action="delete">删除</button>';
  annotationMenu.addEventListener("click", handleAnnotationMenuClick);

  nativeHighlightStyle = document.createElement("style");
  nativeHighlightStyle.dataset.whlNativeHighlights = "true";
  ensureOverlayNodesConnected();
  resizeLayers();
}

function ensureOverlayNodesConnected() {
  const root = document.body || document.documentElement;
  const nodes = [highlightLayer, penLayer, selectionMenu, annotationMenu, nativeHighlightStyle].filter(Boolean);
  for (const node of nodes) {
    if (node.isConnected && node.ownerDocument === document) continue;
    root.appendChild(node);
    debugLog("overlay node reattached", { node: debugNode(node), root: debugNode(root) });
  }
}

async function loadState() {
  const stored = await chrome.storage.local.get("whlState");
  state = normalizeState(stored.whlState);
  if (!stored.whlState || stored.whlState.version !== STATE_VERSION) await persistState();
}

function normalizeState(value) {
  const next = { ...DEFAULT_STATE, ...(value || {}), version: STATE_VERSION };
  if (!value?.modePinned && value?.mode === "browse") {
    next.mode = "highlight";
  }
  return next;
}

async function persistState() {
  await chrome.storage.local.set({ whlState: state });
}

async function loadPageData() {
  const stored = await chrome.storage.local.get(storageKey());
  pageData = normalizePageData(stored[storageKey()]);
}

function requestRemoteData() {
  chrome.runtime.sendMessage({ type: "WHL_LOAD_REMOTE", url: location.href }, (response) => {
    if (!response?.ok || !response.payload) return;
    const remoteData = normalizePageData(response.payload);
    if ((remoteData.updatedAt || 0) > (pageData.updatedAt || 0)) {
      pageData = remoteData;
      saveLocalOnly();
      renderAll();
    }
  });
}

function handleSelection(event) {
  if (event?.target && (selectionMenu.contains(event.target) || annotationMenu.contains(event.target))) {
    debugLog("selection ignored: menu target", debugEventTarget(event.target));
    return;
  }
  debugLog("mouseup selection check", { mode: state.mode, target: debugEventTarget(event?.target) });
  showSelectionMenuFromCurrentSelection("mouseup");
}

function scheduleSelectionMenu() {
  clearTimeout(selectionChangeTimer);
  debugLog("selectionchange scheduled", debugSelectionSnapshot());
  selectionChangeTimer = setTimeout(() => showSelectionMenuFromCurrentSelection("selectionchange"), 80);
}

function showSelectionMenuFromCurrentSelection(source = "unknown") {
  ensureOverlayNodesConnected();
  if (Date.now() < suppressSelectionMenuUntil) {
    debugLog("menu skipped: recently dismissed", { source, suppressSelectionMenuUntil });
    return;
  }
  if (!isTextMode()) {
    debugLog("menu skipped: not text mode", { source, mode: state.mode });
    return;
  }
  const selectionData = getCurrentSelectionData(source);
  if (!selectionData) return;
  pendingSelection = selectionData;
  debugLog("menu render requested", {
    source,
    mode: state.mode,
    textLength: selectionData.text.length,
    textPreview: selectionData.text.slice(0, 60),
    rect: debugRect(selectionData.rect),
    hasOffsets: Number.isInteger(selectionData.start) && Number.isInteger(selectionData.end),
    hasVisualAnchor: Boolean(selectionData.visualAnchor)
  });
  renderSelectionMenu(selectionData.rect, state.mode);
}

function getCurrentSelectionData(source = "unknown") {
  const selection = window.getSelection();
  if (!selection) {
    debugLog("selection skipped: no selection", { source });
    return null;
  }
  if (selection.rangeCount === 0) {
    debugLog("selection skipped: no range", { source, ...debugSelectionSnapshot(selection) });
    return null;
  }
  if (selection.isCollapsed) {
    debugLog("selection skipped: collapsed", { source, ...debugSelectionSnapshot(selection) });
    hideSelectionMenuIfSafe();
    return null;
  }
  const range = selection.getRangeAt(0);
  if (!document.body.contains(range.commonAncestorContainer)) {
    debugLog("selection skipped: outside body", {
      source,
      commonAncestor: debugNode(range.commonAncestorContainer),
      start: debugNode(range.startContainer),
      end: debugNode(range.endContainer)
    });
    return null;
  }

  const selectedText = selection.toString();
  const visualAnchor = createVisualAnchor(range);
  const offsets = rangeToOffsets(range);
  if ((!offsets || offsets.start === offsets.end) && !visualAnchor) {
    debugLog("selection skipped: no usable anchor", {
      source,
      textLength: selectedText.length,
      textPreview: selectedText.slice(0, 60),
      offsets,
      hasVisualAnchor: Boolean(visualAnchor),
      rect: debugRect(selectionRect(range)),
      commonAncestor: debugNode(range.commonAncestorContainer),
      start: debugNode(range.startContainer),
      end: debugNode(range.endContainer)
    });
    return null;
  }

  return {
    start: offsets?.start,
    end: offsets?.end,
    text: selectedText,
    anchor: offsets ? createTextAnchor(range, offsets, selectedText) : null,
    visualAnchor,
    rect: selectionRect(range)
  };
}

function addTextAnnotation(selectionData, color, type = state.mode) {
  if (!selectionData || !isHexColor(color)) return;
  pageData.highlights.push({
    id: createId(),
    type: type === "underline" ? "underline" : "highlight",
    color,
    text: selectionData.text,
    start: selectionData.start,
    end: selectionData.end,
    anchor: selectionData.anchor,
    visualAnchor: selectionData.visualAnchor,
    createdAt: Date.now()
  });
  clearSelection();
  hideSelectionMenu();
  renderTextAnnotations();
  queueSave();
}

function handleKeydown(event) {
  if (matchesShortcut(event, state.highlightShortcut)) {
    const selectionData = getCurrentSelectionData();
    if (selectionData) {
      event.preventDefault();
      addTextAnnotation(selectionData, state.highlightColor, "highlight");
    }
    return;
  }

  if ((event.key === "Backspace" || event.key === "Delete") && state.mode === "eraser") {
    const target = document.querySelector(".whl-eraser-target");
    if (target) removeAnnotation(target.dataset.whlId);
    else if (!annotationMenu.hidden) removeAnnotation(annotationMenu.dataset.whlId);
  }
}

function startPenStroke(event) {
  if (state.mode !== "pen" || event.button !== 0) return;
  event.preventDefault();
  penLayer.setPointerCapture(event.pointerId);
  currentStroke = {
    id: createId(),
    color: state.penColor,
    width: Number(state.penWidth) || DEFAULT_STATE.penWidth,
    points: [eventToPoint(event)],
    createdAt: Date.now()
  };
  currentPath = createPath(currentStroke);
  penLayer.appendChild(currentPath);
}

function continuePenStroke(event) {
  if (!currentStroke || state.mode !== "pen") return;
  event.preventDefault();
  const point = eventToPoint(event);
  const previous = currentStroke.points[currentStroke.points.length - 1];
  if (distance(previous, point) < PEN_MIN_DISTANCE || currentStroke.points.length >= PEN_MAX_POINTS) return;
  currentStroke.points.push(point);
  currentPath.setAttribute("d", pointsToPath(currentStroke.points));
}

function finishPenStroke(event) {
  if (!currentStroke) return;
  penLayer.releasePointerCapture(event.pointerId);
  if (currentStroke.points.length > 1) {
    currentStroke.points = simplifyPoints(currentStroke.points, PEN_MIN_DISTANCE);
    pageData.strokes.push(currentStroke);
    queueSave();
  }
  currentStroke = null;
  currentPath = null;
  renderStrokes();
}

function cancelPenStroke() {
  currentStroke = null;
  currentPath?.remove();
  currentPath = null;
}

function handleLayerClick(event) {
  const target = event.target.closest?.("[data-whl-id]");
  if (!target) return;
  event.preventDefault();
  event.stopPropagation();
  if (state.mode === "eraser") removeAnnotation(target.dataset.whlId);
  else showAnnotationMenuForMark(target.dataset.whlId, target, event.pageX, event.pageY);
}

function handleDocumentClick(event) {
  if (selectionMenu.contains(event.target) || annotationMenu.contains(event.target)) return;
  const target = event.target.closest?.("[data-whl-id]");
  if (target) return;

  const point = { x: event.pageX, y: event.pageY };
  const textHit = findTextAnnotationAtPoint(point);
  if (textHit) {
    event.preventDefault();
    event.stopPropagation();
    if (state.mode === "eraser") removeAnnotation(textHit.annotation.id);
    else showAnnotationMenuForMark(textHit.annotation.id, textHit.mark, point.x, point.y);
    return;
  }

  if (state.mode !== "eraser") return;

  const stroke = findNearestStroke(point, 10);
  if (!stroke) return;
  event.preventDefault();
  event.stopPropagation();
  removeAnnotation(stroke.id);
}

function handleDocumentMouseDown(event) {
  if (!annotationMenu.hidden && !annotationMenu.contains(event.target)) hideAnnotationMenu();
  if (selectionMenu.hidden || selectionMenu.contains(event.target)) return;
  dismissSelectionMenu();
}

function handleDocumentPointerDown(event) {
  if (selectionMenu.hidden || selectionMenu.contains(event.target)) return;
  dismissSelectionMenu();
}

function renderSelectionMenu(rect, type) {
  ensureOverlayNodesConnected();
  selectionMenu.textContent = "";
  const colors = normalizedPalette();
  for (const color of colors) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "whl-color-button";
    button.style.backgroundColor = color;
    button.title = `${type === "underline" ? "划线" : "高亮"}为 ${color}`;
    applyColorButtonCriticalStyle(button, color);
    button.addEventListener("mousedown", (event) => {
      event.preventDefault();
      event.stopPropagation();
      addTextAnnotation(pendingSelection, color, type);
    });
    selectionMenu.appendChild(button);
  }

  const customColor = document.createElement("input");
  customColor.type = "color";
  customColor.value = state.highlightColor;
  customColor.title = `自定义${type === "underline" ? "划线" : "高亮"}颜色`;
  applyColorButtonCriticalStyle(customColor);
  customColor.addEventListener("input", () => {
    state = { ...state, highlightColor: customColor.value };
    persistState();
  });
  customColor.addEventListener("change", () => addTextAnnotation(pendingSelection, customColor.value, type));
  selectionMenu.appendChild(customColor);

  selectionMenu.hidden = false;
  applySelectionMenuCriticalStyle();
  positionFloatingMenu(selectionMenu, rect);
  debugLog("menu rendered", {
    type,
    colorCount: colors.length,
    childCount: selectionMenu.children.length,
    hidden: selectionMenu.hidden,
    rect: debugRect(selectionMenu.getBoundingClientRect()),
    position: { left: selectionMenu.style.left, top: selectionMenu.style.top },
    computed: debugComputedStyle(selectionMenu),
    firstButton: debugMenuChild(selectionMenu.firstElementChild)
  });
}

function applySelectionMenuCriticalStyle() {
  setImportantStyles(selectionMenu, {
    alignItems: "center",
    background: "rgba(32, 33, 36, 0.96)",
    border: "0",
    borderRadius: "999px",
    boxShadow: "0 8px 24px rgba(0, 0, 0, 0.24)",
    boxSizing: "border-box",
    display: "flex",
    flexDirection: "row",
    gap: "8px",
    height: "40px",
    minHeight: "40px",
    minWidth: "176px",
    opacity: "1",
    overflow: "visible",
    padding: "8px 10px",
    pointerEvents: "auto",
    position: "fixed",
    transform: "none",
    visibility: "visible",
    width: "max-content",
    zIndex: "2147483647"
  });
}

function applyColorButtonCriticalStyle(element, color) {
  setImportantStyles(element, {
    appearance: "auto",
    background: color || "transparent",
    border: "2px solid rgba(255, 255, 255, 0.82)",
    borderRadius: "50%",
    boxSizing: "border-box",
    cursor: "pointer",
    display: "inline-block",
    flex: "0 0 auto",
    height: "24px",
    minHeight: "24px",
    minWidth: "24px",
    opacity: "1",
    padding: "0",
    visibility: "visible",
    width: "24px"
  });
}

function setImportantStyles(element, styles) {
  for (const [property, value] of Object.entries(styles)) {
    element.style.setProperty(kebabCase(property), value, "important");
  }
}

function kebabCase(value) {
  return value.replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`);
}

function positionFloatingMenu(menu, anchorRect) {
  const margin = 8;
  const gap = 6;
  menu.style.left = "0px";
  menu.style.top = "0px";
  const menuRect = menu.getBoundingClientRect();
  const maxLeft = Math.max(margin, window.innerWidth - menuRect.width - margin);
  const maxTop = Math.max(margin, window.innerHeight - menuRect.height - margin);
  const preferredLeft = anchorRect.left;
  const preferredTop = anchorRect.bottom + gap;
  const fallbackTop = anchorRect.top - menuRect.height - gap;
  const top = preferredTop <= maxTop ? preferredTop : fallbackTop;
  menu.style.left = `${clamp(preferredLeft, margin, maxLeft)}px`;
  menu.style.top = `${clamp(top, margin, maxTop)}px`;
}

function hideSelectionMenu() {
  pendingSelection = null;
  selectionMenu.hidden = true;
  selectionMenu.style.setProperty("display", "none", "important");
}

function dismissSelectionMenu() {
  suppressSelectionMenuUntil = Date.now() + 350;
  hideSelectionMenu();
  clearSelection();
}

function hideSelectionMenuIfSafe() {
  if (selectionMenu.hidden) return;
  if (selectionMenu.matches(":hover") || selectionMenu.contains(document.activeElement)) return;
  hideSelectionMenu();
}

function clearSelection() {
  const selection = window.getSelection?.() || document.getSelection?.();
  selection?.removeAllRanges();
  selection?.empty?.();
  requestAnimationFrame(() => window.getSelection?.()?.removeAllRanges());
}

function handleAnnotationMenuClick(event) {
  if (event.target.dataset.action !== "delete") return;
  removeAnnotation(annotationMenu.dataset.whlId);
}

function showAnnotationMenu(id, pageX, pageY) {
  annotationMenu.dataset.whlId = id;
  annotationMenu.hidden = false;
  annotationMenu.style.left = `${Math.max(8, pageX)}px`;
  annotationMenu.style.top = `${Math.max(8, pageY - 42)}px`;
}

function showAnnotationMenuForMark(id, mark, pageX, pageY) {
  if (!mark.classList.contains("whl-underline")) {
    showAnnotationMenu(id, pageX, pageY);
    return;
  }

  const rect = mark.getBoundingClientRect();
  annotationMenu.dataset.whlId = id;
  annotationMenu.hidden = false;
  annotationMenu.style.left = `${Math.max(8, rect.left + window.scrollX)}px`;
  annotationMenu.style.top = `${Math.max(8, rect.bottom + window.scrollY + 6)}px`;
}

function hideAnnotationMenu() {
  annotationMenu.hidden = true;
  delete annotationMenu.dataset.whlId;
}

function removeAnnotation(id) {
  hideAnnotationMenu();
  pageData.highlights = pageData.highlights.filter((item) => item.id !== id);
  pageData.strokes = pageData.strokes.filter((item) => item.id !== id);
  renderAll();
  queueSave();
}

function renderAll() {
  ensureOverlayNodesConnected();
  resizeLayers();
  renderTextAnnotations();
  renderStrokes();
  showScrollableOverlayAfterScroll();
}

function renderTextAnnotations() {
  highlightLayer.textContent = "";
  clearNativeTextHighlights();
  const fragment = document.createDocumentFragment();
  const nativeRules = [];
  const useNativeHighlights = supportsNativeHighlights();
  const textIndex = createTextIndex();
  for (const highlight of pageData.highlights) {
    const range = annotationToRange(highlight, textIndex);
    const rectResult = annotationRects(highlight, range);
    if (!rectResult.rects.length) continue;
    const usesNativeHighlight = range && useNativeHighlights && !rectResult.usedVisualAnchor;
    if (usesNativeHighlight) {
      renderNativeTextAnnotation(highlight, range, nativeRules);
    }
    for (const rect of rectResult.rects) {
      const node = document.createElement("div");
      const typeClass = annotationType(highlight) === "underline" ? "whl-underline" : "whl-highlight";
      node.className = `whl-text-mark ${typeClass}${usesNativeHighlight ? " whl-native-hitbox" : ""}${rectResult.usedVisualAnchor ? " whl-visual-anchor" : ""}`;
      node.dataset.whlId = highlight.id;
      node.title = "点击打开操作菜单";
      node.style.setProperty("--whl-color", highlight.color || DEFAULT_STATE.highlightColor);
      node.style.setProperty("--whl-bg", hexToRgba(highlight.color || DEFAULT_STATE.highlightColor, 0.45));
      node.style.left = `${rect.left + window.scrollX}px`;
      node.style.top = `${rect.top + window.scrollY}px`;
      node.style.width = `${rect.width}px`;
      node.style.height = `${rect.height}px`;
      fragment.appendChild(node);
    }
  }
  nativeHighlightStyle.textContent = nativeRules.join("\n");
  highlightLayer.appendChild(fragment);
}


function annotationRects(annotation, range) {
  const visualRects = visualAnchorRects(annotation.visualAnchor);
  if (visualRects.length) return { rects: visualRects, usedVisualAnchor: true };
  if (range) {
    const rects = clientRects(range);
    if (rects.length) return { rects, usedVisualAnchor: false };
  }
  return { rects: [], usedVisualAnchor: false };
}

function clientRects(range) {
  return [...range.getClientRects()].filter((rect) => rect.width >= 1 && rect.height >= 1);
}

function visualAnchorRects(visualAnchor) {
  if (!["katex", "range"].includes(visualAnchor?.type) || !Array.isArray(visualAnchor.rects)) return [];
  const root = visualAnchorRoot(visualAnchor);
  if (!root) return [];
  const rootRect = root.getBoundingClientRect();
  return visualAnchor.rects
    .filter((rect) => rect.width >= 1 && rect.height >= 1)
    .map((rect) => ({
      left: rootRect.left + rect.left,
      top: rootRect.top + rect.top,
      width: rect.width,
      height: rect.height
    }));
}

function visualAnchorRoot(visualAnchor) {
  const direct = elementFromPath(visualAnchor.rootPath);
  if (direct && (visualAnchor.type === "range" || direct.matches?.(".katex"))) return direct;
  const roots = [...document.querySelectorAll(".katex")];
  return roots.find((root) => root.textContent === visualAnchor.rootText)
    || roots.find((root) => root.textContent?.includes(visualAnchor.selectedText || ""));
}

function supportsNativeHighlights() {
  return Boolean(globalThis.CSS?.highlights && globalThis.Highlight);
}

function renderNativeTextAnnotation(annotation, range, nativeRules) {
  const name = nativeHighlightName(annotation.id);
  const color = annotation.color || DEFAULT_STATE.highlightColor;
  CSS.highlights.set(name, new Highlight(range));
  nativeHighlightNames.push(name);
  if (annotationType(annotation) === "underline") {
    nativeRules.push(`::highlight(${name}) { text-decoration: underline 3px ${color}; text-underline-offset: 0.16em; }`);
    return;
  }
  nativeRules.push(`::highlight(${name}) { background-color: ${hexToRgba(color, 0.55)}; color: inherit; }`);
}

function clearNativeTextHighlights() {
  for (const name of nativeHighlightNames) {
    globalThis.CSS?.highlights?.delete(name);
  }
  nativeHighlightNames = [];
  if (nativeHighlightStyle) nativeHighlightStyle.textContent = "";
}

function nativeHighlightName(id) {
  return `whl-${String(id).replace(/[^a-zA-Z0-9_-]/g, "-")}`;
}

function renderStrokes() {
  penLayer.textContent = "";
  const fragment = document.createDocumentFragment();
  for (const stroke of pageData.strokes) {
    fragment.appendChild(createPath(stroke));
  }
  penLayer.appendChild(fragment);
}

function createPath(stroke) {
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.classList.add("whl-pen-path");
  path.dataset.whlId = stroke.id;
  path.setAttribute("d", pointsToPath(stroke.points));
  path.setAttribute("stroke", stroke.color || DEFAULT_STATE.penColor);
  path.setAttribute("stroke-width", stroke.width || DEFAULT_STATE.penWidth);
  return path;
}

function rangeToOffsets(range) {
  const textIndex = createTextIndex();
  let start = null;
  let end = null;
  for (let index = 0; index < textIndex.nodes.length; index += 1) {
    const node = textIndex.nodes[index];
    if (node === range.startContainer) start = textIndex.starts[index] + range.startOffset;
    if (node === range.endContainer) end = textIndex.starts[index] + range.endOffset;
    if (Number.isInteger(start) && Number.isInteger(end)) break;
  }
  return Number.isInteger(start) && Number.isInteger(end) ? { start, end } : null;
}

function createTextAnchor(range, offsets, text) {
  const fullText = documentTextFromIndex(createTextIndex());
  return {
    version: 1,
    prefix: fullText.slice(Math.max(0, offsets.start - ANCHOR_CONTEXT_CHARS), offsets.start),
    suffix: fullText.slice(offsets.end, offsets.end + ANCHOR_CONTEXT_CHARS),
    startPath: nodePath(range.startContainer),
    endPath: nodePath(range.endContainer),
    startOffset: range.startOffset,
    endOffset: range.endOffset,
    textHash: hashText(text)
  };
}

function annotationToRange(annotation, textIndex) {
  const direct = buildRange(annotation.start, annotation.end, textIndex);
  if (rangeMatchesText(direct, annotation.text)) return direct;

  const anchored = rangeFromDomAnchor(annotation);
  if (rangeMatchesText(anchored, annotation.text)) return anchored;

  const quoted = rangeFromTextQuote(annotation, textIndex);
  if (quoted) return quoted;
  return annotation.text ? null : direct;
}

function rangeFromDomAnchor(annotation) {
  const anchor = annotation.anchor;
  if (!anchor?.startPath || !anchor?.endPath) return null;
  const startNode = nodeFromPath(anchor.startPath);
  const endNode = nodeFromPath(anchor.endPath);
  if (!startNode || !endNode) return null;
  if (anchor.startOffset > startNode.nodeValue.length || anchor.endOffset > endNode.nodeValue.length) return null;
  const range = document.createRange();
  range.setStart(startNode, anchor.startOffset);
  range.setEnd(endNode, anchor.endOffset);
  return range;
}

function rangeFromTextQuote(annotation, textIndex) {
  if (!annotation.text) return null;
  const candidates = findTextCandidates(textIndex.fullText, annotation.text);
  let best = null;
  for (const start of candidates) {
    const score = scoreTextCandidate(start, annotation, textIndex.fullText);
    if (!best || score > best.score) best = { start, score };
  }
  if (!best || best.score < MIN_ANCHOR_SCORE) return null;
  return buildRange(best.start, best.start + annotation.text.length, textIndex);
}

function buildRange(start, end, textIndex = createTextIndex()) {
  if (!Number.isInteger(start) || !Number.isInteger(end) || start > end) return null;
  const startPoint = pointAtOffset(start, textIndex);
  const endPoint = pointAtOffset(end, textIndex);
  if (!startPoint || !endPoint) return null;
  const range = document.createRange();
  range.setStart(startPoint.node, startPoint.offset);
  range.setEnd(endPoint.node, endPoint.offset);
  return range;
}

function pointAtOffset(offset, textIndex) {
  let low = 0;
  let high = textIndex.nodes.length - 1;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const start = textIndex.starts[mid];
    const end = start + textIndex.nodes[mid].nodeValue.length;
    if (offset < start) high = mid - 1;
    else if (offset > end) low = mid + 1;
    else return { node: textIndex.nodes[mid], offset: offset - start };
  }
  return null;
}


function createTextIndex() {
  const nodes = [];
  const starts = [];
  const parts = [];
  let position = 0;
  const walker = textWalker();
  while (walker.nextNode()) {
    const value = walker.currentNode.nodeValue;
    nodes.push(walker.currentNode);
    starts.push(position);
    parts.push(value);
    position += value.length;
  }
  return { nodes, starts, fullText: parts.join("") };
}

function documentTextFromIndex(textIndex) {
  return textIndex.fullText || "";
}

function rangeMatchesText(range, text, allowPartial = false) {
  if (!range) return false;
  if (!text) return true;
  const actual = range.toString();
  return allowPartial ? actual.includes(text) || text.includes(actual) : actual === text;
}

function findTextCandidates(fullText, text) {
  const candidates = [];
  if (!text || !fullText) return candidates;
  let index = fullText.indexOf(text);
  while (index >= 0 && candidates.length < MAX_TEXT_CANDIDATES) {
    candidates.push(index);
    index = fullText.indexOf(text, index + Math.max(1, text.length));
  }
  return candidates;
}

function scoreTextCandidate(start, annotation, fullText) {
  const anchor = annotation.anchor || {};
  const end = start + annotation.text.length;
  let score = 50;
  score += contextScore(fullText.slice(0, start), anchor.prefix, "suffix") * 20;
  score += contextScore(fullText.slice(end), anchor.suffix, "prefix") * 20;
  if (Number.isInteger(annotation.start)) {
    const distance = Math.abs(start - annotation.start);
    score += Math.max(0, 10 - Math.min(distance, 1000) / 100);
  }
  return score;
}

function contextScore(actual, expected, side) {
  if (!expected) return 0.5;
  const limit = Math.min(actual.length, expected.length, ANCHOR_CONTEXT_CHARS);
  let matched = 0;
  for (let index = 1; index <= limit; index += 1) {
    const actualPart = side === "suffix" ? actual.slice(-index) : actual.slice(0, index);
    const expectedPart = side === "suffix" ? expected.slice(-index) : expected.slice(0, index);
    if (actualPart === expectedPart) matched = index;
  }
  return matched / Math.max(1, Math.min(expected.length, ANCHOR_CONTEXT_CHARS));
}


function elementPath(element) {
  const path = [];
  let current = element;
  while (current && current !== document.body) {
    const parent = current.parentNode;
    if (!parent) return null;
    path.unshift([...parent.children].indexOf(current));
    current = parent;
  }
  return current === document.body ? path.join(".") : null;
}

function elementFromPath(path) {
  if (typeof path !== "string") return null;
  let current = document.body;
  for (const segment of path.split(".").filter(Boolean)) {
    const index = Number(segment);
    if (!Number.isInteger(index) || !current?.children?.[index]) return null;
    current = current.children[index];
  }
  return current?.nodeType === Node.ELEMENT_NODE ? current : null;
}

function nodePath(node) {
  const path = [];
  let current = node;
  while (current && current !== document.body) {
    const parent = current.parentNode;
    if (!parent) return null;
    path.unshift([...parent.childNodes].indexOf(current));
    current = parent;
  }
  return current === document.body ? path.join(".") : null;
}

function nodeFromPath(path) {
  if (typeof path !== "string") return null;
  let current = document.body;
  for (const segment of path.split(".").filter(Boolean)) {
    const index = Number(segment);
    if (!Number.isInteger(index) || !current?.childNodes?.[index]) return null;
    current = current.childNodes[index];
  }
  return current?.nodeType === Node.TEXT_NODE ? current : null;
}

function hashText(text) {
  let hash = 0;
  for (let index = 0; index < String(text || "").length; index += 1) {
    hash = ((hash << 5) - hash + text.charCodeAt(index)) | 0;
  }
  return String(hash);
}

function textWalker() {
  return document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!node.nodeValue || !node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
      if (isIgnoredTextNode(node)) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    }
  });
}

function isIgnoredTextNode(node) {
  const parent = node.parentElement;
  if (!parent) return true;
  if (highlightLayer.contains(parent) || penLayer.contains(parent)) return true;
  return Boolean(parent.closest("script, style, noscript, template, .katex-mathml, .whl-selection-menu, .whl-annotation-menu"));
}

function applyModeClass() {
  for (const root of [document.documentElement, document.body]) {
    root.classList.toggle("whl-highlight-active", state.mode === "highlight");
    root.classList.toggle("whl-underline-active", state.mode === "underline");
    root.classList.toggle("whl-pen-active", state.mode === "pen");
    root.classList.toggle("whl-eraser-active", state.mode === "eraser");
  }
}

function resizeLayers() {
  const width = Math.max(document.documentElement.scrollWidth, document.body?.scrollWidth || 0, window.innerWidth);
  const height = Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight || 0, window.innerHeight);
  highlightLayer.style.width = `${width}px`;
  highlightLayer.style.height = `${height}px`;
  penLayer.setAttribute("width", width);
  penLayer.setAttribute("height", height);
}


function createVisualAnchor(range) {
  const formulaRoot = closestRangeElement(range, ".katex") || intersectedElement(range, ".katex");
  if (!formulaRoot) return null;
  const root = closestRangeElement(range, ".katex") || visualRangeRoot(range) || formulaRoot;
  const rootRect = root.getBoundingClientRect();
  const rects = visualClientRects(range).map((rect) => ({
    left: rect.left - rootRect.left,
    top: rect.top - rootRect.top,
    width: rect.width,
    height: rect.height
  }));
  if (!rects.length) return null;
  return {
    version: 1,
    type: root.matches?.(".katex") ? "katex" : "range",
    rootPath: elementPath(root),
    rootText: root.textContent || "",
    selectedText: range.toString(),
    rects
  };
}

function visualClientRects(range) {
  return clientRects(range).filter((rect) => rect.width > 2 && rect.height > 2);
}

function intersectedElement(range, selector) {
  const scope = range.commonAncestorContainer?.nodeType === Node.ELEMENT_NODE
    ? range.commonAncestorContainer
    : range.commonAncestorContainer?.parentElement;
  const candidates = scope?.querySelectorAll ? scope.querySelectorAll(selector) : document.querySelectorAll(selector);
  for (const element of candidates) {
    try {
      if (range.intersectsNode(element)) return element;
    } catch (_error) {
    }
  }
  return null;
}

function visualRangeRoot(range) {
  let element = range.commonAncestorContainer?.nodeType === Node.ELEMENT_NODE
    ? range.commonAncestorContainer
    : range.commonAncestorContainer?.parentElement;
  while (element && element !== document.body) {
    if (elementPath(element)) return element;
    element = element.parentElement;
  }
  return document.body;
}

function closestRangeElement(range, selector) {
  return closestElement(range.commonAncestorContainer, selector)
    || closestElement(range.startContainer, selector)
    || closestElement(range.endContainer, selector);
}

function closestElement(node, selector) {
  const element = node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement;
  return element?.closest?.(selector) || null;
}

function selectionRect(range) {
  const rects = [...range.getClientRects()].filter((item) => item.width > 0 && item.height > 0);
  if (!rects.length) return range.getBoundingClientRect();
  const left = Math.min(...rects.map((item) => item.left));
  const top = Math.min(...rects.map((item) => item.top));
  const right = Math.max(...rects.map((item) => item.right));
  const bottom = Math.max(...rects.map((item) => item.bottom));
  return { left, top, right, bottom, width: right - left, height: bottom - top };
}

function normalizedPalette() {
  const colors = Array.isArray(state.highlightPalette) ? state.highlightPalette : [];
  return [...new Set([state.highlightColor, ...colors].filter(isHexColor))].slice(0, 8);
}

function isHexColor(value) {
  return /^#[0-9a-f]{6}$/i.test(String(value || ""));
}

function matchesShortcut(event, shortcut) {
  const parts = String(shortcut || "").split("+").map((item) => item.trim().toLowerCase()).filter(Boolean);
  const key = parts.find((part) => !["ctrl", "control", "cmd", "meta", "alt", "shift"].includes(part));
  if (!key) return false;
  return event.ctrlKey === (parts.includes("ctrl") || parts.includes("control"))
    && event.metaKey === (parts.includes("cmd") || parts.includes("meta"))
    && event.altKey === parts.includes("alt")
    && event.shiftKey === parts.includes("shift")
    && event.key.toLowerCase() === key;
}

function isTextMode() {
  return state.mode === "highlight" || state.mode === "underline";
}

function annotationType(annotation) {
  return annotation.type === "underline" ? "underline" : "highlight";
}

function findTextAnnotationAtPoint(point) {
  const viewportX = point.x - window.scrollX;
  const viewportY = point.y - window.scrollY;
  const marks = [...highlightLayer.querySelectorAll(".whl-text-mark")];
  for (let index = marks.length - 1; index >= 0; index -= 1) {
    const rect = marks[index].getBoundingClientRect();
    if (viewportX >= rect.left && viewportX <= rect.right && viewportY >= rect.top && viewportY <= rect.bottom) {
      const annotation = pageData.highlights.find((item) => item.id === marks[index].dataset.whlId);
      return annotation ? { annotation, mark: marks[index] } : null;
    }
  }
  return null;
}

function simplifyPoints(points, minDistance) {
  if (points.length <= 2) return points;
  const simplified = [points[0]];
  for (let index = 1; index < points.length - 1; index += 1) {
    const point = points[index];
    if (distance(simplified[simplified.length - 1], point) >= minDistance) simplified.push(point);
  }
  const last = points[points.length - 1];
  if (distance(simplified[simplified.length - 1], last) > 0) simplified.push(last);
  return simplified.slice(0, PEN_MAX_POINTS);
}

function queueSave() {
  pageData.url = location.href;
  pageData.updatedAt = Date.now();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 300);
}

async function saveNow() {
  await saveLocalOnly();
  chrome.runtime.sendMessage({ type: "WHL_SAVE_REMOTE", url: location.href, payload: pageData });
}

async function saveLocalOnly() {
  if (isEmptyPageData(pageData)) {
    await chrome.storage.local.remove(storageKey());
    await removeFromLocalIndex(storageKey());
    return;
  }
  await chrome.storage.local.set({ [storageKey()]: pageData });
  await updateLocalIndex();
}

async function updateLocalIndex() {
  const key = storageKey();
  const stored = await chrome.storage.local.get(STORAGE_INDEX_KEY);
  const index = normalizeStorageIndex(stored[STORAGE_INDEX_KEY]);
  index.pages[key] = {
    url: location.href,
    updatedAt: pageData.updatedAt || Date.now(),
    size: estimateJsonSize(pageData)
  };
  await chrome.storage.local.set({ [STORAGE_INDEX_KEY]: index });
}

async function removeFromLocalIndex(key) {
  const stored = await chrome.storage.local.get(STORAGE_INDEX_KEY);
  const index = normalizeStorageIndex(stored[STORAGE_INDEX_KEY]);
  delete index.pages[key];
  await chrome.storage.local.set({ [STORAGE_INDEX_KEY]: index });
}

async function cleanupLocalStorage(force = false) {
  const stored = await chrome.storage.local.get(STORAGE_INDEX_KEY);
  let index = normalizeStorageIndex(stored[STORAGE_INDEX_KEY]);
  if (force || !index.migrated) index = await migrateLocalIndex(index);
  const now = Date.now();
  const entries = Object.entries(index.pages);
  const expired = entries
    .filter(([, item]) => now - (item.updatedAt || 0) > LOCAL_TTL_MS)
    .map(([key]) => key);
  const overflow = entries
    .filter(([key]) => !expired.includes(key))
    .sort(([, left], [, right]) => (right.updatedAt || 0) - (left.updatedAt || 0))
    .slice(MAX_LOCAL_PAGES)
    .map(([key]) => key);
  const keysToRemove = [...new Set([...expired, ...overflow])];
  if (!force && keysToRemove.length === 0) return { removed: 0, remaining: entries.length };
  if (keysToRemove.length) await chrome.storage.local.remove(keysToRemove);
  for (const key of keysToRemove) delete index.pages[key];
  await chrome.storage.local.set({ [STORAGE_INDEX_KEY]: index });
  return { removed: keysToRemove.length, remaining: Object.keys(index.pages).length };
}

function normalizeStorageIndex(index) {
  return { migrated: Boolean(index?.migrated), pages: { ...(index?.pages || {}) } };
}

async function migrateLocalIndex(index) {
  const stored = await chrome.storage.local.get(null);
  for (const [key, value] of Object.entries(stored)) {
    if (!key.startsWith(STORAGE_PREFIX) || index.pages[key]) continue;
    index.pages[key] = {
      url: value?.url || key.slice(STORAGE_PREFIX.length),
      updatedAt: value?.updatedAt || Date.now(),
      size: estimateJsonSize(value || {})
    };
  }
  index.migrated = true;
  await chrome.storage.local.set({ [STORAGE_INDEX_KEY]: index });
  return index;
}

function estimateJsonSize(value) {
  return new Blob([JSON.stringify(value)]).size;
}

function storageKey() {
  return `${STORAGE_PREFIX}${location.href}`;
}

function emptyPageData() {
  return { url: location.href, highlights: [], strokes: [], updatedAt: 0 };
}

function isEmptyPageData(data) {
  return !data.highlights?.length && !data.strokes?.length;
}

function normalizePageData(data) {
  return {
    ...emptyPageData(),
    ...(data || {}),
    highlights: Array.isArray(data?.highlights) ? data.highlights : [],
    strokes: Array.isArray(data?.strokes) ? data.strokes : []
  };
}

function createId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  const random = Math.random().toString(36).slice(2);
  return `whl-${Date.now().toString(36)}-${random}`;
}

function eventToPoint(event) {
  return { x: Math.round(event.pageX), y: Math.round(event.pageY) };
}

function pointsToPath(points) {
  if (!points?.length) return "";
  const [first, ...rest] = points;
  return `M ${first.x} ${first.y} ${rest.map((point) => `L ${point.x} ${point.y}`).join(" ")}`;
}

function distance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function findNearestStroke(point, threshold) {
  let nearest = null;
  let bestDistance = Infinity;
  for (const stroke of pageData.strokes) {
    for (const strokePoint of stroke.points || []) {
      const candidateDistance = distance(point, strokePoint);
      if (candidateDistance < bestDistance) {
        bestDistance = candidateDistance;
        nearest = stroke;
      }
    }
  }
  return bestDistance <= threshold ? nearest : null;
}

function counts() {
  return {
    highlights: pageData.highlights.filter((item) => annotationType(item) === "highlight").length,
    underlines: pageData.highlights.filter((item) => annotationType(item) === "underline").length,
    strokes: pageData.strokes.length
  };
}

function hexToRgba(hex, alpha) {
  const value = hex.replace("#", "");
  const number = Number.parseInt(value.length === 3 ? value.replace(/(.)/g, "$1$1") : value, 16);
  const red = (number >> 16) & 255;
  const green = (number >> 8) & 255;
  const blue = number & 255;
  return `rgba(${red}, ${green}, ${blue}, ${alpha})`;
}

function debugLog(message, data = {}) {
  if (!DEBUG_ENABLED) return;
  console.info(`[WHL][${new Date().toISOString()}] ${message}`, data);
}

function debugSelectionSnapshot(selection = window.getSelection?.()) {
  if (!selection) return { hasSelection: false };
  return {
    hasSelection: true,
    rangeCount: selection.rangeCount,
    collapsed: selection.isCollapsed,
    textLength: selection.toString().length,
    textPreview: selection.toString().slice(0, 60),
    activeElement: debugNode(document.activeElement)
  };
}

function debugEventTarget(target) {
  return debugNode(target);
}

function debugNode(node) {
  if (!node) return null;
  if (node.nodeType === Node.TEXT_NODE) {
    return {
      type: 'text',
      textLength: node.nodeValue?.length || 0,
      textPreview: node.nodeValue?.slice(0, 40) || '',
      parent: debugNode(node.parentElement)
    };
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return { type: `node-${node.nodeType}` };
  const element = node;
  return {
    type: element.tagName?.toLowerCase(),
    id: element.id || '',
    className: String(element.className || '').slice(0, 120),
    role: element.getAttribute?.('role') || '',
    contentEditable: element.getAttribute?.('contenteditable') || '',
    rect: debugRect(element.getBoundingClientRect?.())
  };
}

function debugRect(rect) {
  if (!rect) return null;
  return {
    left: Math.round(rect.left),
    top: Math.round(rect.top),
    right: Math.round(rect.right),
    bottom: Math.round(rect.bottom),
    width: Math.round(rect.width),
    height: Math.round(rect.height)
  };
}

function debugComputedStyle(element) {
  if (!element) return null;
  const style = getComputedStyle(element);
  return {
    display: style.display,
    position: style.position,
    visibility: style.visibility,
    opacity: style.opacity,
    width: style.width,
    height: style.height,
    minWidth: style.minWidth,
    minHeight: style.minHeight,
    padding: style.padding,
    overflow: style.overflow,
    pointerEvents: style.pointerEvents,
    zIndex: style.zIndex
  };
}

function debugMenuChild(element) {
  if (!element) return null;
  return {
    tag: element.tagName?.toLowerCase(),
    rect: debugRect(element.getBoundingClientRect()),
    computed: debugComputedStyle(element)
  };
}

function debounce(fn, delay) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  };
}

})();
