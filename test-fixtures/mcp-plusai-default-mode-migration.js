async (page) => {
  await page.goto('https://ns01.plusai.io/c/69eb2f35-cd08-8330-aef1-9a548a3f7866', { waitUntil: 'domcontentloaded' });
  await page.addStyleTag({ path: '/Users/wangyaqi49/code_room/web_highlight/src/content/content.css' });
  await page.evaluate(() => {
    window.__whlStore = { whlState: { mode: 'browse' } };
    window.__whlMessages = [];
    window.chrome = {
      storage: { local: {
        async get(key) {
          if (key === null) return { ...window.__whlStore };
          return typeof key === 'string' ? { [key]: window.__whlStore[key] } : {};
        },
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

  const status = await page.evaluate(() => new Promise((resolve) => {
    window.__whlListener({ type: 'WHL_GET_STATUS' }, null, resolve);
  }));

  const target = await page.evaluate(() => {
    const elements = [...document.querySelectorAll('main p, .markdown p, p, [data-message-author-role]')];
    const el = elements.find((item) => item.innerText?.trim().length > 8 && item.getBoundingClientRect().width > 20);
    const rect = el?.getBoundingClientRect();
    return rect ? { x: rect.left, y: rect.top, width: rect.width, height: rect.height, text: el.innerText.slice(0, 80) } : null;
  });
  if (!target) return { error: 'no visible target', status };

  await page.mouse.move(target.x + 5, target.y + Math.min(18, target.height / 2));
  await page.mouse.down();
  await page.mouse.move(target.x + Math.min(180, target.width - 5), target.y + Math.min(18, target.height / 2), { steps: 16 });
  await page.mouse.up();
  await page.waitForTimeout(220);

  return await page.evaluate((status) => {
    const selection = getSelection();
    const menu = document.querySelector('.whl-selection-menu');
    const storedState = window.__whlStore.whlState;
    return {
      status,
      storedState,
      selected: selection?.toString(),
      menuShown: Boolean(menu && !menu.hidden),
      buttonCount: menu?.querySelectorAll('.whl-color-button').length || 0
    };
  }, status);
}
