/**
 * scripts/diagnose-modal.js — 活体诊断：弹窗"看得见点不着"
 *
 * 前置：应用已以 --remote-debugging-port=9333 启动
 * 用法：node scripts/diagnose-modal.js
 *
 * 做法：通过 CDP 连进 widget 渲染进程，
 *  1) 程序化打开日程弹窗
 *  2) elementFromPoint 检查弹窗关键点上"真正接住点击的元素"
 *  3) 用 CDP Input.dispatchMouseEvent 走真实命中测试管线点击"取消"
 *  4) dump 所有 app-region: drag 元素的矩形（drag 区域命中不遵守 z-index）
 */
const DEBUG_PORT = process.argv[2] || '9333';

async function getTargets() {
  const res = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json`);
  if (!res.ok) throw new Error('json 接口失败: ' + res.status);
  return res.json();
}

function connectWS(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const pending = new Map();
    let seq = 0;
    const events = [];
    ws.onopen = () => resolve({
      send(method, params = {}) {
        return new Promise((res2, rej2) => {
          const id = ++seq;
          pending.set(id, { res2, rej2 });
          ws.send(JSON.stringify({ id, method, params }));
        });
      },
      events,
      close: () => ws.close(),
    });
    ws.onmessage = (m) => {
      const msg = JSON.parse(m.data);
      if (msg.id && pending.has(msg.id)) {
        const p = pending.get(msg.id);
        pending.delete(msg.id);
        msg.error ? p.rej2(new Error(msg.error.message)) : p.res2(msg.result);
      } else if (msg.method) {
        events.push(msg);
      }
    };
    ws.onerror = reject;
  });
}

async function evalJS(cdp, expr) {
  const r = await cdp.send('Runtime.evaluate', {
    expression: expr,
    returnByValue: true,
    awaitPromise: true,
  });
  if (r.exceptionDetails) {
    return { __error: r.exceptionDetails.exception?.description || r.exceptionDetails.text };
  }
  return r.result.value;
}

(async () => {
  const targets = await getTargets();
  const page = targets.find(t => t.type === 'page' && t.url.includes('widget.html'));
  if (!page) {
    console.log('未找到 widget.html 页面目标。现有 targets:');
    console.log(targets.map(t => `${t.type} ${t.url}`).join('\n'));
    process.exit(2);
  }
  const cdp = await connectWS(page.webSocketDebuggerUrl);
  await cdp.send('Runtime.enable');
  await new Promise(r => setTimeout(r, 300));

  const report = {};

  // 0) 基本信息
  report.env = await evalJS(cdp, `JSON.stringify({
    dpr: window.devicePixelRatio,
    hasFocus: document.hasFocus(),
    active: document.activeElement && (document.activeElement.id || document.activeElement.tagName),
    winSize: [window.innerWidth, window.innerHeight],
    visibility: document.visibilityState,
  })`);

  // 1) 打开弹窗（复用页面自己的 contextmenu 流程）
  report.opened = await evalJS(cdp, `(() => {
    const day = [...document.querySelectorAll('#days .day')].find(x => x.dataset.date);
    if (!day) return 'no day cell';
    day.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    const mask = document.getElementById('scheduleModal');
    return { hidden: mask.hidden, display: getComputedStyle(mask).display };
  })()`);
  await new Promise(r => setTimeout(r, 150));

  // 2) 关键点命中测试
  report.hitTest = await evalJS(cdp, `(() => {
    const probe = (elId) => {
      const el = document.getElementById(elId);
      if (!el) return 'missing #' + elId;
      const r = el.getBoundingClientRect();
      const cx = r.x + r.width / 2, cy = r.y + r.height / 2;
      const top = document.elementFromPoint(cx, cy);
      const chain = [];
      let e = top;
      while (e && chain.length < 6) { chain.push(e.tagName + (e.id ? '#' + e.id : '') + (e.className && typeof e.className === 'string' ? '.' + e.className.split(' ').join('.') : '')); e = e.parentElement; }
      return { rect: [r.x, r.y, r.width, r.height], topAtPoint: top ? top.tagName + (top.id ? '#' + top.id : '') : 'null', chain, isSelfOrChild: el === top || el.contains(top) };
    };
    return JSON.stringify({
      fTitle: probe('fTitle'),
      fDate: probe('fDate'),
      btnCancel: probe('btnCancelSchedule'),
      btnSave: probe('btnSaveSchedule'),
    });
  })()`);

  // 3) 弹窗与遮挡层的 computed style
  report.styles = await evalJS(cdp, `(() => {
    const pick = (el) => {
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      return { rect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)],
        display: cs.display, pointerEvents: cs.pointerEvents, zIndex: cs.zIndex,
        appRegion: cs.webkitAppRegion || cs.appRegion, opacity: cs.opacity, visibility: cs.visibility };
    };
    return JSON.stringify({
      mask: pick(document.getElementById('scheduleModal')),
      modal: pick(document.querySelector('#scheduleModal .modal')),
      dragBar: pick(document.querySelector('.drag-bar')),
      body: pick(document.body),
    });
  })()`);

  // 4) 所有 app-region: drag 元素矩形（drag 命中不遵守 z-index/层叠）
  report.dragRects = await evalJS(cdp, `(() => {
    const out = [];
    for (const el of document.querySelectorAll('*')) {
      const cs = getComputedStyle(el);
      const region = cs.webkitAppRegion || cs.appRegion;
      if (region === 'drag') {
        const r = el.getBoundingClientRect();
        out.push({ sel: el.tagName + (el.id ? '#' + el.id : '') + (typeof el.className === 'string' && el.className ? '.' + el.className.split(' ').join('.') : ''), rect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)] });
      }
    }
    return JSON.stringify(out);
  })()`);

  // 5) 真实 CDP 鼠标点击"取消"按钮（走完整 Chromium 命中测试，含 drag region 处理）
  const cancelRect = await evalJS(cdp, `(() => {
    const r = document.getElementById('btnCancelSchedule').getBoundingClientRect();
    return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
  })()`);
  const { x, y } = JSON.parse(cancelRect);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  await new Promise(r => setTimeout(r, 400));

  report.afterRealClick = await evalJS(cdp, `(() => {
    const mask = document.getElementById('scheduleModal');
    return JSON.stringify({ modalHiddenAfterRealClick: mask.hidden, active: document.activeElement && (document.activeElement.id || document.activeElement.tagName) });
  })()`);

  // 若弹窗还开着，再真实点击一次"标题输入框"并尝试键盘输入
  if (report.afterRealClick && !JSON.parse(report.afterRealClick).modalHiddenAfterRealClick) {
    const t = JSON.parse(await evalJS(cdp, `(() => { const r = document.getElementById('fTitle').getBoundingClientRect(); return JSON.stringify({ x: r.x + r.width/2, y: r.y + r.height/2 }); })()`));
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: t.x, y: t.y, button: 'left', clickCount: 1 });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: t.x, y: t.y, button: 'left', clickCount: 1 });
    await new Promise(r => setTimeout(r, 200));
    await cdp.send('Input.dispatchKeyEvent', { type: 'char', text: 'x' });
    await new Promise(r => setTimeout(r, 200));
    report.afterTypeTest = await evalJS(cdp, `JSON.stringify({ value: document.getElementById('fTitle').value, active: document.activeElement && (document.activeElement.id || document.activeElement.tagName) })`);
  }

  // 6) 会话期间的异常/控制台错误
  report.consoleErrors = cdp.events
    .filter(e => e.method === 'Runtime.exceptionThrown' || (e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error'))
    .slice(0, 8)
    .map(e => JSON.stringify(e.params).slice(0, 300));

  console.log(JSON.stringify(report, null, 2));
  cdp.close();
  process.exit(0);
})().catch(e => { console.error('诊断失败:', e.message); process.exit(1); });
