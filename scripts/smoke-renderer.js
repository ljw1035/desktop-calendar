/**
 * scripts/smoke-renderer.js — 渲染层冒烟测试（jsdom）
 *
 * 为什么需要它：沙箱没有 GUI，Electron 渲染进程跑不起来，
 * widget.js / settings.js 里任何运行时错误都只能等用户在真机上双击才暴露。
 * 这里用 jsdom 真实解析 HTML + 执行 JS，提前抓出：
 *
 *   1. 脚本加载 / init() 执行过程中的运行时异常
 *   2. 没匹配到任何元素的选择器（按钮点了没反应的元凶），并给出源码行号
 *   3. console.error 输出
 *
 * 用法：npm run smoke
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const SRC = path.join(__dirname, '..', 'src');

// ---------- 桩数据：尽量贴近真实返回，好让渲染分支真的跑到 ----------
const pad = (n) => String(n).padStart(2, '0');
const now = new Date();
const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;

const sampleSchedules = [
  { id: 1, title: '示例日程 A', note: '', date: today, start_time: '09:00', end_time: '10:00', color: '#ff7a59', done: 0, repeat: 'weekly', occurrenceDate: today, isRecurring: true },
  { id: 2, title: '示例日程 B', note: '带备注', date: today, start_time: '', end_time: '', color: '#5b8def', done: 1, repeat: 'none', occurrenceDate: today, isRecurring: false },
];
const sampleTodos = [
  { id: 1, content: '示例待办 1', done: 0 },
  { id: 2, content: '示例待办 2', done: 1 },
];
const sampleConfig = {
  opacity: 0.92, width: 760, height: 900, x: null, y: null,
  showLunar: true, showTodos: true, weekStartsOn: 1,
  theme: 'glacier', startWithSystem: false,
  alwaysOnTop: true, clickThrough: false,
};

function makeApiStub(record) {
  return {
    schedule: {
      list: async () => sampleSchedules,
      byDate: async () => sampleSchedules,
      create: async (d) => ({ id: 99, ...d }),
      update: async (d) => d,
      toggleDone: async () => ({}),
      remove: async () => ({}),
      onFocus: (cb) => { record.cbs.push('schedule.onFocus'); record.handlers.focus.push(cb); },
    },
    todo: {
      list: async () => sampleTodos,
      create: async (d) => ({ id: 99, ...d }),
      update: async (d) => d,
      remove: async () => ({}),
    },
    config: {
      get: async () => sampleConfig,
      set: async (p) => { record.configSets.push(p); },
      onChange: (cb) => { record.cbs.push('config.onChange'); record.handlers.config.push(cb); },
    },
    data: { onChange: (cb) => { record.cbs.push('data.onChange'); record.handlers.data.push(cb); } },
    window: {
      close: async () => {}, hide: async () => {},
      openSettings: async () => {}, toggleDevTools: async () => {},
    },
  };
}

function runCase(label, htmlFile, jsFiles, assertFn) {
  console.log(`\n=== ${label}（${htmlFile} + ${jsFiles.join(', ')}）===`);
  const html = fs.readFileSync(path.join(SRC, htmlFile), 'utf8');

  const vc = new VirtualConsole();
  const consoleErrors = [];
  const jsdomErrors = [];
  vc.on('error', (...a) => consoleErrors.push(a.join(' ')));
  vc.on('jsdomError', (e) => jsdomErrors.push(e.message));

  const dom = new JSDOM(html, {
    runScripts: 'outside-only',
    virtualConsole: vc,
    url: 'http://localhost/',
    pretendToBeVisual: true,
  });
  const { window } = dom;

  // jsdom 没实现 matchMedia，补一个
  if (!window.matchMedia) {
    window.matchMedia = () => ({
      matches: false, media: '', onchange: null,
      addListener() {}, removeListener() {},
      addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false,
    });
  }

  // 记录"没匹配到元素"的选择器，附源码行号
  const misses = [];
  for (const fn of ['querySelector', 'querySelectorAll']) {
    const orig = window.document[fn].bind(window.document);
    window.document[fn] = function (sel) {
      const r = orig(sel);
      const found = fn === 'querySelectorAll' ? r && r.length > 0 : r != null;
      if (!found) {
        const stack = new Error().stack || '';
        const line = stack.split('\n').find((l) => /(widget|settings)\.js:\d+/.test(l));
        misses.push({ sel, where: (line || '').trim().replace(/^at\s+/, '') });
      }
      return r;
    };
  }

  const record = { cbs: [], configSets: [], handlers: { config: [], data: [], focus: [] } };
  window.api = makeApiStub(record);

  const loadErrors = [];
  for (const f of jsFiles) {
    const code = fs.readFileSync(path.join(SRC, f), 'utf8');
    try {
      // sourceURL 让堆栈里能显示 widget.js:行号
      window.eval(code + `\n//# sourceURL=${f}`);
    } catch (e) {
      loadErrors.push(`[${f}] ${e.message}`);
    }
  }

  // 等 init() 的异步流程跑完
  return new Promise((resolve) => {
    setTimeout(() => {
      console.log(`  已注册回调   : ${record.cbs.length ? record.cbs.join(', ') : '（无）'}`);
      console.log(`  config.set  : ${record.configSets.length} 次`);
      if (loadErrors.length) {
        console.log('  加载异常     :');
        loadErrors.forEach((e) => console.log('    ✗ ' + e));
      }
      if (jsdomErrors.length) {
        console.log('  运行时异常   :');
        jsdomErrors.forEach((e) => console.log('    ✗ ' + e));
      }
      if (consoleErrors.length) {
        console.log('  console.error:');
        consoleErrors.forEach((e) => console.log('    ✗ ' + e));
      }
      if (misses.length) {
        console.log(`  未命中选择器 : ${misses.length} 个`);
        const seen = new Set();
        for (const m of misses) {
          const key = m.sel + m.where;
          if (seen.has(key)) continue;
          seen.add(key);
          console.log(`    ⚠ ${m.sel}   ${m.where}`);
        }
      }
      // 光"没报错"不够，还要证明 DOM 真的被渲染出来了
      let assertFail = 0;
      if (assertFn) {
        console.log('  DOM 断言     :');
        for (const a of assertFn(window)) {
          if (!a.ok) assertFail++;
          console.log(`    ${a.ok ? 'PASS' : 'FAIL'}  ${a.label}  (${a.detail})`);
        }
      }

      const ok = !loadErrors.length && !jsdomErrors.length && !consoleErrors.length && assertFail === 0;
      console.log(`  结果         : ${ok ? 'PASS' : 'FAIL'}${misses.length && ok ? `，但有 ${misses.length} 个未命中选择器需人工确认` : ''}`);
      resolve({ ok, misses, jsdomErrors, loadErrors, consoleErrors, window, record });
    }, 300);
  });
}

(async () => {
  const unhandled = [];
  process.on('unhandledRejection', (r) => unhandled.push(String(r && r.message ? r.message : r)));

  const a = await runCase('小组件渲染', 'widget.html', ['lunar.js', 'widget.js'], (w) => {
    const d = w.document;
    const days = d.querySelectorAll('#days > *').length;
    const week = d.querySelectorAll('#weekdays > *').length;
    const todos = d.querySelectorAll('#todoList > *').length;
    const title = ((d.querySelector('#monthTitle') || {}).textContent || '').trim();
    const meta = ((d.querySelector('#monthMeta') || {}).textContent || '').trim();
    // 色板已渲染 inline 背景（每个 span 应有非空 backgroundColor），否则视为渲染异常
    const swatches = Array.from(d.querySelectorAll('#colorRow span'));
    const swatchesRendered = swatches.length > 0 && swatches.every(s => s.style.backgroundColor && s.style.backgroundColor !== 'rgba(0, 0, 0, 0)' && s.style.backgroundColor !== 'transparent');
    return [
      { label: '日历格子已渲染', ok: days >= 28 && days % 7 === 0 && days <= 35, detail: `#days 有 ${days} 个格子（期望 28 或 35，最小行数无下月透明行）` },
      { label: '星期表头 7 个', ok: week === 7, detail: `实际 ${week} 个` },
      { label: '待办已渲染（桩数据 2 条）', ok: todos === 2, detail: `实际 ${todos} 条` },
      { label: '月份标题已填充', ok: title.length > 0, detail: JSON.stringify(title) },
      { label: '农历/节日信息已填充', ok: meta.length > 0, detail: JSON.stringify(meta.slice(0, 40)) },
      { label: '颜色色板已渲染 inline 背景', ok: swatchesRendered, detail: swatchesRendered ? `7 个色板背景色均已写入` : `渲染异常，可能仍是透明状态` },
    ];
  });

  const b = await runCase('设置窗渲染', 'settings.html', ['settings.js'], (w) => {
    const d = w.document;
    const rows = d.querySelectorAll('#scheduleRows > *').length;
    const todos = d.querySelectorAll('#todoList > *').length;
    const op = d.querySelector('#opacity');
    const wd = d.querySelector('#width');
    const checks = ['alwaysOnTop', 'clickThrough', 'showLunar', 'showTodos', 'startWithSystem']
      .map((id) => `${id}=${d.querySelector('#' + id) ? d.querySelector('#' + id).checked : '?'}`)
      .join(' ');
    return [
      { label: '日程表格已渲染（桩数据 2 条）', ok: rows === 2, detail: `实际 ${rows} 行` },
      { label: '待办已渲染（桩数据 2 条）', ok: todos === 2, detail: `实际 ${todos} 条` },
      { label: '透明度滑块已回填(92)', ok: op && Number(op.value) === 92, detail: `opacity=${op ? op.value : '?'}` },
      { label: '宽度滑块已回填(760)', ok: wd && Number(wd.value) === 760, detail: `width=${wd ? wd.value : '?'}` },
      { label: '开关状态已回填', ok: /alwaysOnTop=true/.test(checks) && /showLunar=true/.test(checks), detail: checks },
    ];
  });

  // ---------- 交互模拟：关掉「显示农历」，验证开关真的生效 ----------
  console.log('\n=== 交互模拟：切换「显示农历」开关 ===');
  a.record.handlers.config.forEach((cb) => cb({ ...sampleConfig, showLunar: false }));
  await new Promise((r) => setTimeout(r, 150));
  const wd = a.window.document;
  const noLunarClass = wd.body.classList.contains('no-lunar');
  const metaHidden = wd.querySelector('#monthMeta').style.display === 'none';
  const lunarEls = wd.querySelectorAll('.day-lunar').length;
  const toggleOk = noLunarClass && metaHidden && lunarEls > 0;
  console.log(`  body.no-lunar 类      : ${noLunarClass}`);
  console.log(`  月份副标题已隐藏       : ${metaHidden}`);
  console.log(`  农历元素仍在 DOM 中    : ${lunarEls} 个（靠 CSS 隐藏，符合预期）`);
  console.log(`  结果                  : ${toggleOk ? 'PASS（开关生效）' : 'FAIL（开关没生效）'}`);

  // ---------- 交互模拟：日程弹窗 + 重复规则回填（回归：#fRepeat 曾缺失导致弹窗崩溃） ----------
  console.log('\n=== 交互模拟：日程弹窗与重复规则回填 ===');
  const wdoc = a.window.document;
  wdoc.querySelector('#btnAddSchedule').click();
  await new Promise((r) => setTimeout(r, 100));
  const modalOpen = wdoc.querySelector('#scheduleModal') && !wdoc.querySelector('#scheduleModal').hidden;
  const repNew = wdoc.querySelector('#fRepeat') ? wdoc.querySelector('#fRepeat').value : '(元素缺失)';
  wdoc.querySelector('#scheduleList .schedule-item [data-act="edit"]').click();
  await new Promise((r) => setTimeout(r, 100));
  const repEdit = wdoc.querySelector('#fRepeat') ? wdoc.querySelector('#fRepeat').value : '(元素缺失)';
  const repOk = !!modalOpen && repNew === 'none' && repEdit === 'weekly';
  console.log(`  添加日程弹窗可打开     : ${!!modalOpen}`);
  console.log(`  新建时重复规则默认值   : ${repNew}（期望 none）`);
  console.log(`  编辑时重复规则回填     : ${repEdit}（期望 weekly）`);
  console.log(`  结果                   : ${repOk ? 'PASS（弹窗与回填正常）' : 'FAIL'}`);

  // ---------- 交互模拟：日程详情列表的色板按各自颜色渲染（回归：之前只改日历格子色，详情列表仍红） ----------
  console.log('\n=== 交互模拟：日程详情列表颜色渲染 ===');
  const detailItems = Array.from(wdoc.querySelectorAll('#scheduleList .schedule-item'));
  const detailColors = detailItems.map(el => el.style.getPropertyValue('--accent').trim());
  const detailColorOk = detailItems.length > 0 && detailColors.every(c => c && c.startsWith('#'));
  console.log(`  详情列表条数           : ${detailItems.length}`);
  console.log(`  每条 --accent           : ${JSON.stringify(detailColors)}`);
  console.log(`  结果                   : ${detailColorOk ? 'PASS（详情列表颜色按日程颜色渲染）' : 'FAIL（详情列表颜色未读取）'}`);

  // ---------- 交互模拟：设置窗新建日程弹窗 ----------
  console.log('\n=== 交互模拟：设置窗新建日程弹窗 ===');
  const sdoc = b.window.document;
  sdoc.querySelector('#btnNewSchedule').click();
  await new Promise((r) => setTimeout(r, 100));
  const sModalOpen = sdoc.querySelector('#scheduleModal') && !sdoc.querySelector('#scheduleModal').hidden;
  const sRep = sdoc.querySelector('#fRepeat') ? sdoc.querySelector('#fRepeat').value : '(元素缺失)';
  const sRepOk = !!sModalOpen && sRep === 'none';
  console.log(`  设置窗弹窗可打开       : ${!!sModalOpen}`);
  console.log(`  重复规则默认值         : ${sRep}（期望 none）`);
  console.log(`  结果                   : ${sRepOk ? 'PASS' : 'FAIL'}`);

  await new Promise((r) => setTimeout(r, 200));

  console.log('\n=== 汇总 ===');
  if (unhandled.length) {
    console.log('未处理的 Promise 拒绝：');
    unhandled.forEach((u) => console.log('  ✗ ' + u));
  }
  const allOk = a.ok && b.ok && toggleOk && repOk && sRepOk && unhandled.length === 0;
  console.log(allOk ? '渲染层冒烟测试通过 ✓' : '渲染层冒烟测试发现问题 ✗');
  process.exit(allOk ? 0 : 1);
})();
