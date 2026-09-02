/**
 * scripts/diag-native-step.js — 原生点击诊断的辅助步骤
 * 用法：
 *   node diag-native-step.js prepare <port>   # 打开弹窗、窗口置前，输出取消按钮的屏幕物理坐标
 *   node diag-native-step.js check <port>     # 输出弹窗当前 hidden 状态
 */
const port = process.argv[3];
const mode = process.argv[2];

async function main() {
  const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
  const page = targets.find(t => t.type === 'page' && t.url.includes('widget.html'));
  if (!page) { console.log(JSON.stringify({ error: 'no widget target' })); process.exit(2); }

  const ws = await new Promise((resolve, reject) => {
    const w = new WebSocket(page.webSocketDebuggerUrl);
    w.onopen = () => resolve(w);
    w.onerror = reject;
  });
  let seq = 0;
  const pending = new Map();
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && pending.has(msg.id)) {
      const p = pending.get(msg.id); pending.delete(msg.id);
      msg.error ? p.rej(new Error(msg.error.message)) : p.res(msg.result);
    }
  };
  const send = (method, params = {}) => new Promise((res, rej) => {
    const id = ++seq; pending.set(id, { res, rej });
    ws.send(JSON.stringify({ id, method, params }));
  });
  const evalJS = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true });
    if (r.exceptionDetails) return { __err: r.exceptionDetails.exception?.description || 'err' };
    return r.result.value;
  };

  if (mode === 'prepare') {
    await send('Page.enable');
    await send('Page.bringToFront');
    await new Promise(r => setTimeout(r, 500));
    const out = await evalJS(`(() => {
      const day = [...document.querySelectorAll('#days .day')].find(x => x.dataset.date);
      if (day) day.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
      const btn = document.getElementById('btnCancelSchedule');
      const r = btn.getBoundingClientRect();
      return JSON.stringify({
        screenX: window.screenX, screenY: window.screenY,
        outer: [window.outerWidth, window.outerHeight], inner: [window.innerWidth, window.innerHeight],
        dpr: window.devicePixelRatio,
        cssPoint: [r.x + r.width / 2, r.y + r.height / 2],
        modalHidden: document.getElementById('scheduleModal').hidden,
      });
    })()`);
    console.log(typeof out === 'string' ? out : JSON.stringify(out));
  } else if (mode === 'check') {
    const out = await evalJS(`JSON.stringify({ modalHidden: document.getElementById('scheduleModal').hidden, value: document.getElementById('fTitle').value })`);
    console.log(out);
  }
  ws.close();
  process.exit(0);
}
main().catch(e => { console.error(e.message); process.exit(1); });
