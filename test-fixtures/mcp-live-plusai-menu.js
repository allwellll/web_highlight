async (page) => {
  await page.goto('https://ns01.plusai.io/c/69eb2f35-cd08-8330-aef1-9a548a3f7866', { waitUntil: 'domcontentloaded' });
  await page.addStyleTag({ path: '/Users/wangyaqi49/code_room/web_highlight/src/content/content.css' });
  await page.evaluate(() => {
    window.__whlStore = {};
    window.__whlMessages = [];
    window.chrome = {
      storage: { local: {
        async get(key) { if (key === null) return { ...window.__whlStore }; return typeof key === 'string' ? { [key]: window.__whlStore[key] } : {}; },
        async set(value) { Object.assign(window.__whlStore, value); },
        async remove(keys) { for (const key of Array.isArray(keys) ? keys : [keys]) delete window.__whlStore[key]; }
      } },
      runtime: {
        onMessage: { addListener(listener) { window.__whlListener = listener; } },
        sendMessage(message, callback) {
          window.__whlMessages.push(message);
          if (message.type === 'WHL_LOAD_REMOTE') callback?.({ ok: true, payload: null });
          if (message.type === 'WHL_SAVE_REMOTE') callback?.({ ok: true, queued: true });
        }
      }
    };
  });
  await page.addScriptTag({ path: '/Users/wangyaqi49/code_room/web_highlight/src/content/content.js' });
  await page.waitForTimeout(500);
  await page.evaluate(() => new Promise((resolve) => window.__whlListener({ type: 'WHL_SET_MODE', state: { mode: 'highlight', highlightColor: '#ffe600', highlightPalette: ['#ffe600'] } }, null, resolve)));

  const result = await page.evaluate(async () => {
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!node.nodeValue?.trim()) return NodeFilter.FILTER_REJECT;
        const parent = node.parentElement;
        if (!parent || parent.closest('script, style, noscript, template, .katex-mathml')) return NodeFilter.FILTER_REJECT;
        const rect = parent.getBoundingClientRect();
        return rect.width > 20 && rect.height > 8 ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      }
    });
    const node = walker.nextNode();
    if (!node) return { error: 'no text node' };
    const text = node.nodeValue;
    const start = Math.max(0, text.search(/\S/));
    const end = Math.min(text.length, start + 8);
    const range = document.createRange();
    range.setStart(node, start);
    range.setEnd(node, end);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    document.dispatchEvent(new Event('selectionchange', { bubbles: true }));
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    await sleep(220);
    const menu = document.querySelector('.whl-selection-menu');
    const rect = menu?.getBoundingClientRect();
    return {
      selected: selection.toString(),
      menuShown: Boolean(menu && !menu.hidden),
      buttonCount: menu?.querySelectorAll('.whl-color-button').length || 0,
      menuRect: rect ? { left: rect.left, top: rect.top, width: rect.width, height: rect.height } : null,
      ignoredScriptNodes: [...document.querySelectorAll('script')].reduce((sum, el) => sum + (el.textContent?.length || 0), 0)
    };
  });
  return result;
}
