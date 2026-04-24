import json
from pathlib import Path

root = Path(__file__).resolve().parents[1]
css = (root / 'src/content/content.css').read_text()
js = (root / 'src/content/content.js').read_text()
body = r'''
  await page.addStyleTag({ content: CSS_TEXT });
  await page.evaluate(() => {
    window.__whlStore = {};
    window.__whlMessages = [];
    window.chrome = {
      storage: { local: {
        async get(key) {
          if (key == null) return { ...window.__whlStore };
          if (typeof key === 'string') return { [key]: window.__whlStore[key] };
          if (Array.isArray(key)) return Object.fromEntries(key.map((item) => [item, window.__whlStore[item]]));
          return { ...key, ...Object.fromEntries(Object.keys(key).map((item) => [item, window.__whlStore[item] ?? key[item]])) };
        },
        async set(value) { Object.assign(window.__whlStore, value); }
      } },
      runtime: {
        onMessage: { addListener(listener) { window.__whlListener = listener; } },
        sendMessage(message, callback) {
          window.__whlMessages.push(message);
          if (message.type === 'WHL_LOAD_REMOTE') callback?.({ ok: true, payload: null });
          if (message.type === 'WHL_SAVE_REMOTE') callback?.({ ok: true, queued: true });
          if (message.type === 'WHL_GET_SYNC_CONFIG') callback?.({ enabled: false });
          if (message.type === 'WHL_SET_SYNC_CONFIG') callback?.({ ok: true });
        }
      }
    };
  });
  await page.addScriptTag({ content: JS_TEXT });
  await page.waitForTimeout(300);
  return await page.evaluate(async () => {
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const listener = window.__whlListener;
    const sendToContent = (message) => new Promise((resolve) => listener(message, null, resolve));
    const selectText = (selector, from, to) => {
      const textNode = document.querySelector(selector).firstChild;
      const text = textNode.nodeValue;
      const start = text.indexOf(from);
      const end = text.indexOf(to) + to.length;
      const range = document.createRange();
      range.setStart(textNode, start);
      range.setEnd(textNode, end);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    };
    const key = () => Object.keys(window.__whlStore).find((item) => item.startsWith('whl:page:'));
    const pageData = () => window.__whlStore[key()];

    const initial = {
      hasHighlightLayer: Boolean(document.querySelector('.whl-layer')),
      hasPenLayer: Boolean(document.querySelector('.whl-pen-layer'))
    };

    await sendToContent({ type: 'WHL_SET_MODE', state: { mode: 'highlight', highlightColor: '#ffe600', highlightPalette: ['#ffe600', '#7cff7c', '#74c0fc'], highlightShortcut: 'Alt+H' } });
    selectText('#math', 'E = mc²', '∀x∈ℝ');
    await sleep(100);
    const menuShown = !document.querySelector('.whl-selection-menu').hidden;
    document.querySelector('.whl-color-button[style*="rgb(124, 255, 124)"]')?.click();
    await sleep(450);
    const afterMenuHighlight = {
      menuShown,
      highlightRects: document.querySelectorAll('.whl-highlight').length,
      storedHighlights: pageData()?.highlights.length || 0,
      storedText: pageData()?.highlights[0]?.text || '',
      storedColor: pageData()?.highlights[0]?.color || '',
      saveMessages: window.__whlMessages.filter((item) => item.type === 'WHL_SAVE_REMOTE').length
    };

    selectText('#normal', '普通文字', '高亮');
    document.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, altKey: true, key: 'h' }));
    await sleep(450);
    const afterShortcutHighlight = {
      storedHighlights: pageData()?.highlights.length || 0,
      colors: (pageData()?.highlights || []).map((item) => item.color)
    };

    await sendToContent({ type: 'WHL_SET_MODE', state: { mode: 'underline', highlightColor: '#74c0fc', highlightPalette: ['#74c0fc'] } });
    selectText('#long', '跨行文本', '高亮层');
    await sleep(100);
    document.querySelector('.whl-color-button')?.click();
    await sleep(450);
    const afterUnderline = {
      underlineRects: document.querySelectorAll('.whl-underline').length,
      storedUnderlines: (pageData()?.highlights || []).filter((item) => item.type === 'underline').length
    };

    document.querySelector('.whl-highlight')?.click();
    await sleep(100);
    const afterClickMenu = {
      deleteMenuShown: !document.querySelector('.whl-annotation-menu').hidden
    };
    document.querySelector('.whl-annotation-menu [data-action="delete"]')?.click();
    await sleep(450);
    const afterMenuDelete = {
      storedHighlights: (pageData()?.highlights || []).filter((item) => item.type !== 'underline').length,
      storedUnderlines: (pageData()?.highlights || []).filter((item) => item.type === 'underline').length
    };

    await sendToContent({ type: 'WHL_SET_MODE', state: { mode: 'pen', penColor: '#e53935', penWidth: 6 } });
    const svg = document.querySelector('.whl-pen-layer');
    const pointerOptions = { bubbles: true, pointerId: 1, button: 0, buttons: 1, clientX: 180, clientY: 210 };
    svg.dispatchEvent(new PointerEvent('pointerdown', pointerOptions));
    svg.dispatchEvent(new PointerEvent('pointermove', { ...pointerOptions, clientX: 230, clientY: 230 }));
    svg.dispatchEvent(new PointerEvent('pointermove', { ...pointerOptions, clientX: 280, clientY: 220 }));
    svg.dispatchEvent(new PointerEvent('pointerup', { ...pointerOptions, clientX: 280, clientY: 220, buttons: 0 }));
    await sleep(450);
    const afterPen = {
      strokePaths: document.querySelectorAll('.whl-pen-path').length,
      storedStrokes: pageData()?.strokes.length || 0
    };

    await sendToContent({ type: 'WHL_SET_MODE', state: { mode: 'eraser' } });
    document.querySelector('.whl-highlight')?.click();
    await sleep(450);
    const afterEraseHighlight = {
      highlightRects: document.querySelectorAll('.whl-highlight').length,
      storedHighlights: pageData()?.highlights.length || 0,
      storedStrokes: pageData()?.strokes.length || 0
    };

    await sendToContent({ type: 'WHL_CLEAR_PAGE' });
    await sleep(450);
    const afterClear = {
      highlightRects: document.querySelectorAll('.whl-highlight').length,
      strokePaths: document.querySelectorAll('.whl-pen-path').length,
      storedHighlights: pageData()?.highlights.length || 0,
      storedStrokes: pageData()?.strokes.length || 0
    };
    return { initial, afterMenuHighlight, afterShortcutHighlight, afterUnderline, afterClickMenu, afterMenuDelete, afterPen, afterEraseHighlight, afterClear };
  });
'''
runner = 'async (page) => {\n' + body.replace('CSS_TEXT', json.dumps(css)).replace('JS_TEXT', json.dumps(js)) + '\n}'
(root / 'test-fixtures/mcp-content-smoke.js').write_text(runner)
