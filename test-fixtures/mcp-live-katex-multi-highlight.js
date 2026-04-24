async (page) => {
  await page.goto('https://ns01.plusai.io/c/69eb2f35-cd08-8330-aef1-9a548a3f7866', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.katex', { timeout: 10000 });
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
  await page.evaluate(() => new Promise((resolve) => window.__whlListener({ type: 'WHL_SET_MODE', state: { mode: 'highlight', highlightColor: '#ffe600', highlightPalette: ['#ffe600', '#7cff7c', '#74c0fc', '#ffadad'] } }, null, resolve)));

  return await page.evaluate(async () => {
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const textNodes = [];
    for (const katex of [...document.querySelectorAll('.katex')].slice(0, 20)) {
      const walker = document.createTreeWalker(katex, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
          if (!node.nodeValue?.trim()) return NodeFilter.FILTER_REJECT;
          if (node.parentElement?.closest('.katex-mathml')) return NodeFilter.FILTER_REJECT;
          const rect = node.parentElement?.getBoundingClientRect();
          return rect && rect.width > 1 && rect.height > 1 ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
        }
      });
      let node;
      while ((node = walker.nextNode())) {
        if (node.nodeValue.trim().length > 0) textNodes.push(node);
      }
      if (textNodes.length >= 4) break;
    }

    const attempts = [];
    for (const [index, node] of textNodes.slice(0, 4).entries()) {
      const text = node.nodeValue;
      const start = Math.max(0, text.search(/\S/));
      const end = Math.min(text.length, start + Math.max(1, Math.min(2, text.trim().length)));
      const range = document.createRange();
      range.setStart(node, start);
      range.setEnd(node, end);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      document.dispatchEvent(new Event('selectionchange', { bubbles: true }));
      document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      await sleep(180);
      const menu = document.querySelector('.whl-selection-menu');
      const button = menu?.querySelectorAll('.whl-color-button')[index % 4];
      const beforeMarks = document.querySelectorAll('.whl-highlight').length;
      const beforeNative = CSS.highlights?.size || 0;
      button?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
      await sleep(380);
      const marks = [...document.querySelectorAll('.whl-highlight')].map((el) => {
        const rect = el.getBoundingClientRect();
        return {
          width: rect.width,
          height: rect.height,
          background: getComputedStyle(el).backgroundColor,
          backgroundImage: getComputedStyle(el).backgroundImage,
          opacity: getComputedStyle(el).opacity,
          hitbox: el.classList.contains('whl-native-hitbox')
        };
      });
      const key = Object.keys(window.__whlStore).find((item) => item.startsWith('whl:page:'));
      const saved = window.__whlStore[key]?.highlights || [];
      attempts.push({
        index,
        selected: text.slice(start, end),
        menuShown: Boolean(menu && !menu.hidden),
        beforeMarks,
        afterMarks: marks.length,
        beforeNative,
        afterNative: CSS.highlights?.size || 0,
        savedCount: saved.length,
        lastHasVisualAnchor: Boolean(saved.at(-1)?.visualAnchor),
        visibleColoredRects: marks.filter((mark) => !mark.hitbox && mark.width > 0 && mark.height > 0 && mark.background !== 'rgba(0, 0, 0, 0)').length,
        lowObstructionRects: marks.filter((mark) => !mark.hitbox && mark.backgroundImage.includes('linear-gradient') && Number(mark.opacity) <= 0.72).length,
        hitboxRects: marks.filter((mark) => mark.hitbox && mark.width > 0 && mark.height > 0).length
      });
    }
    return { nodeCount: textNodes.length, attempts };
  });
}
