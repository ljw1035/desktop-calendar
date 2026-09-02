/**
 * settings.js — 设置页面
 *
 * 左：日程管理（CRUD）、待办管理
 * 右：小组件参数（透明度、缩放、置顶、穿透、显示项、主题）
 *
 * 所有 config 变更即时同步到主进程（widget 立刻生效）。
 */
'use strict';
const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));
const pad2 = (n) => String(n).padStart(2, '0');

let editingId = null;
let editingColor = '#ff6b6b';

// 快捷键录制状态（v1.1.2：两个快捷键各一份独立录制态）
let shortcutRecording = false;
let shortcutPendingAcc = null;   // 正在等待用户确认的组合（本地合法但尚未应用）
const shortcutState = {
  toggle: { recording: false, pending: null },
  clickThrough: { recording: false, pending: null },
};

// 给弹窗里"颜色"色板（#colorRow span[data-c]）一次性写入 inline background，
// 避免 CSS 缺 background-color 导致 7 个圆点全透明。
function initColorSwatches() {
  $$('#colorRow span').forEach(s => {
    const c = s.dataset.c;
    if (c) s.style.backgroundColor = c;
  });
}
let currentFilter = { month: '', keyword: '', done: 'all' };

// ---------- 工具 ----------
function escapeText(s) { return String(s ?? '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])); }
function todayMonth() {
  const t = new Date();
  return `${t.getFullYear()}-${pad2(t.getMonth() + 1)}`;
}

// ---------- 加载配置 → UI ----------
async function loadConfigToUI() {
  const cfg = await window.api.config.get();
  $('#opacity').value       = Math.round(cfg.opacity * 100);
  $('#opacityVal').textContent = `${$('#opacity').value}%`;
  $('#width').value         = cfg.width;
  $('#widthVal').textContent = `${cfg.width} px`;
  $('#height').value        = cfg.height;
  $('#heightVal').textContent = `${cfg.height} px`;
  $('#alwaysOnTop').checked   = !!cfg.alwaysOnTop;
  $('#clickThrough').checked = !!cfg.clickThrough;
  $('#showLunar').checked    = cfg.showLunar !== false;
  $('#showTodos').checked    = cfg.showTodos !== false;
  $('#startWithSystem').checked = !!cfg.startWithSystem;
  // 快捷键：输入框显示友好格式，data-acc 存真实 accelerator（供回退显示）
  syncShortcutInput(cfg, 'toggleShortcut', 'shortcut');
  setShortcutStatus('当前：' + window.accelerator.formatAccelerator(cfg.toggleShortcut || window.accelerator.DEFAULT_SHORTCUT), '');
  // v1.1.2：第二个快捷键（穿透开关）
  syncShortcutInput(cfg, 'clickThroughShortcut', 'shortcut2');
  const el2 = $('#shortcutStatus2');
  if (el2) {
    el2.textContent = '当前：' + window.accelerator.formatAccelerator(cfg.clickThroughShortcut || window.accelerator.DEFAULT_CLICK_THROUGH_SHORTCUT);
    el2.className = 'shortcut-status';
  }
  $$('input[name="weekStart"]').forEach(r => r.checked = (Number(r.value) === (cfg.weekStartsOn ?? 1)));
  $$('input[name="theme"]').forEach(r => r.checked = (r.value === (cfg.theme || 'glacier')));
  $('#filterMonth').value = todayMonth();
  currentFilter.month = $('#filterMonth').value;
}

// ---------- 快捷键自定义 ----------

/**
 * v1.1.2：通用快捷键录制器
 *
 * params = {
 *   inputId:        输入框元素 id
 *   statusId:       状态文字 span id
 *   configKey:      配置里的字段名（'toggleShortcut' | 'clickThroughShortcut'）
 *   okEvent:        渲染层监听的成功 IPC（config.onShortcutOk | config.onClickThroughShortcutOk）
 *   errorEvent:     失败 IPC
 *   setPending:     主进程 IPC：config:set partial，把 configKey 写进去
 *   defaultAcc:     失败回退 / "恢复默认" 按钮用的 default
 * }
 *
 * 之所以抽成函数：两个快捷键（toggleShortcut / clickThroughShortcut）的事件管线一模一样。
 */
function bindShortcutCaptureRow(params) {
  const input  = $('#' + params.inputId);
  const status = $('#' + params.statusId);
  const setStatus = (text, type) => {
    if (!status) return;
    status.textContent = text;
    status.className = 'shortcut-status' + (type ? ' ' + type : '');
  };
  const syncFrom = (cfg) => {
    const sc = (cfg && cfg[params.configKey]) || params.defaultAcc;
    input.value = window.accelerator.formatAccelerator(sc);
    input.dataset.acc = sc;
  };

  const exitRecord = () => {
    params.state.recording = false;
    params.state.pending = null;
    input.classList.remove('recording');
    input.blur();
    // 恢复显示当前生效值（pending 未应用 → 显生效值）
    syncFrom(cfgCache);
    setStatus('点击方框后按下新组合键（Esc 取消）', '');
  };

  input.addEventListener('click', () => {
    params.state.recording = true;
    input.classList.add('recording');
    input.value = '';
    input.placeholder = '请按下组合键…';
    setStatus('请按下新的组合键（只按修饰键则继续等待主键）', '');
  });
  input.addEventListener('blur', () => {
    if (params.state.recording) exitRecord();
  });
  input.addEventListener('keydown', async (e) => {
    if (!params.state.recording) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.code === 'Escape') { exitRecord(); return; }

    const { accelerator, reason } = window.accelerator.keydownToAccelerator(e);
    if (!accelerator && !reason) {
      input.value = '';
      input.placeholder = window.accelerator.formatAccelerator(
        [e.ctrlKey && 'Ctrl', e.altKey && 'Alt', e.shiftKey && 'Shift', e.metaKey && 'Win']
          .filter(Boolean).join('+')) + ' + …';
      return;
    }
    if (!accelerator) {
      setStatus(reason || '该组合无效，请重试', 'err');
      input.value = '';
      input.placeholder = '请再按一次组合键…';
      return;
    }

    params.state.pending = accelerator;
    input.value = window.accelerator.formatAccelerator(accelerator);
    input.placeholder = '点击方框后按下快捷键…';
    try {
      await params.setPending(accelerator);
    } catch (err) {
      params.state.recording = false;
      input.classList.remove('recording');
      syncFrom(cfgCache);
      setStatus('保存失败：' + (err && err.message), 'err');
    }
  });

  // "恢复默认"
  const resetBtn = document.querySelector('[data-reset-target="' + params.inputId + '"]');
  if (resetBtn) {
    resetBtn.addEventListener('click', async () => {
      input.value = window.accelerator.formatAccelerator(params.defaultAcc);
      input.dataset.acc = params.defaultAcc;
      try {
        await params.setPending(params.defaultAcc);
      } catch (err) {
        setStatus('保存失败：' + (err && err.message), 'err');
      }
    });
  }

  // 成功：直接用事件携带的 accelerator 刷新输入框（不依赖 cfgCache 时序）
  params.okEvent((acc) => {
    params.state.recording = false;
    params.state.pending = null;
    input.classList.remove('recording');
    input.value = window.accelerator.formatAccelerator(acc);
    input.dataset.acc = acc;
    if (cfgCache) cfgCache = { ...cfgCache, [params.configKey]: acc };
    setStatus('✓ 已生效：' + window.accelerator.formatAccelerator(acc), 'ok');
  });
  // 失败：从主进程拉最新 config 回填（最可靠）
  params.errorEvent(async (msg) => {
    params.state.recording = false;
    params.state.pending = null;
    input.classList.remove('recording');
    const fresh = await window.api.config.get();
    cfgCache = fresh;
    syncFrom(fresh);
    setStatus('⚠ ' + msg + '（已保留原快捷键）', 'err');
  });
}

// 同步快捷键输入框（从 cfg 拉数据；轻量工具）
function syncShortcutInput(cfg, configKey, inputId) {
  const el = $('#' + inputId);
  if (!el) return;
  const sc = (cfg && cfg[configKey]) || '';
  el.value = window.accelerator.formatAccelerator(sc);
  el.dataset.acc = sc;
}

function setShortcutStatus(text, type) {
  // type: '' 普通 / 'ok' 成功 / 'err' 失败
  const el = $('#shortcutStatus');
  if (!el) return;
  el.textContent = text;
  el.className = 'shortcut-status' + (type ? ' ' + type : '');
}

// 从当前生效值刷新快捷键输入框（失败回滚后 / 加载时用）
function syncShortcutFromConfig(cfg) {
  if (!cfg) return;
  if (cfg.toggleShortcut !== undefined) syncShortcutInput(cfg, 'toggleShortcut', 'shortcut');
  if (cfg.clickThroughShortcut !== undefined) syncShortcutInput(cfg, 'clickThroughShortcut', 'shortcut2');
}

// 绑定快捷键录制交互：v1.1.2 两个录制项都用 bindShortcutCaptureRow 统一驱动
function bindShortcutCapture() {
  bindShortcutCaptureRow({
    inputId:     'shortcut',
    statusId:    'shortcutStatus',
    configKey:   'toggleShortcut',
    state:       shortcutState.toggle,
    defaultAcc:  window.accelerator.DEFAULT_SHORTCUT,
    setPending:  (acc) => window.api.config.set({ toggleShortcut: acc }),
    okEvent:     (cb) => window.api.config.onShortcutOk(cb),
    errorEvent:  (cb) => window.api.config.onShortcutError(cb),
  });
  bindShortcutCaptureRow({
    inputId:     'shortcut2',
    statusId:    'shortcutStatus2',
    configKey:   'clickThroughShortcut',
    state:       shortcutState.clickThrough,
    defaultAcc:  window.accelerator.DEFAULT_CLICK_THROUGH_SHORTCUT,
    setPending:  (acc) => window.api.config.set({ clickThroughShortcut: acc }),
    okEvent:     (cb) => window.api.config.onClickThroughShortcutOk(cb),
    errorEvent:  (cb) => window.api.config.onClickThroughShortcutError(cb),
  });
}

// 当前生效 config 缓存（供 syncShortcutFromConfigCache 使用）
let cfgCache = null;
function syncShortcutFromConfigCache() {
  if (cfgCache) syncShortcutFromConfig(cfgCache);
}

// 监听 config:changed 广播（外部触发 / 回滚后）→ 同步两个快捷键输入框
function bindShortcutEvents() {
  window.api.config.onChange((cfg) => {
    const prev = cfgCache;
    cfgCache = cfg;
    // 任一快捷键字段变化且当前没有在录制 → 刷新
    const ts = (cfg.toggleShortcut || '') !== (prev?.toggleShortcut || '');
    const cs = (cfg.clickThroughShortcut || '') !== (prev?.clickThroughShortcut || '');
    if (ts && !shortcutState.toggle.recording) {
      syncShortcutInput(cfg, 'toggleShortcut', 'shortcut');
      setShortcutStatus('当前：' + window.accelerator.formatAccelerator(cfg.toggleShortcut || window.accelerator.DEFAULT_SHORTCUT), '');
    }
    if (cs && !shortcutState.clickThrough.recording) {
      const el2 = $('#shortcutStatus2');
      if (el2) {
        el2.textContent = '当前：' + window.accelerator.formatAccelerator(cfg.clickThroughShortcut || window.accelerator.DEFAULT_CLICK_THROUGH_SHORTCUT);
        el2.className = 'shortcut-status';
      }
    }
  });
}

// ---------- 绑定：右侧配置 ----------
function bindConfigEvents() {
  const sliderUpdate = (key, transform = v => v) => {
    return async (e) => {
      const v = transform(e.target.value);
      await window.api.config.set({ [key]: v });
      e.target.nextElementSibling?.classList.contains('value') && (
        e.target.parentElement.querySelector('.value').textContent =
          key === 'opacity' ? `${v}%` : `${v} px`);
    };
  };

  $('#opacity').addEventListener('input', async (e) => {
    const v = Number(e.target.value) / 100;
    $('#opacityVal').textContent = `${e.target.value}%`;
    await window.api.config.set({ opacity: v });
  });
  // 用 input 事件：拖动时实时调整小组件大小（change 要松手才触发，之前显得"没反应"）
  $('#width').addEventListener('input', async (e) => {
    $('#widthVal').textContent = `${e.target.value} px`;
    await window.api.config.set({ width: Number(e.target.value) });
  });
  $('#height').addEventListener('input', async (e) => {
    $('#heightVal').textContent = `${e.target.value} px`;
    await window.api.config.set({ height: Number(e.target.value) });
  });

  $('#alwaysOnTop').addEventListener('change', async (e) => {
    await window.api.config.set({ alwaysOnTop: e.target.checked });
  });
  $('#clickThrough').addEventListener('change', async (e) => {
    await window.api.config.set({ clickThrough: e.target.checked });
  });
  $('#showLunar').addEventListener('change', async (e) => {
    await window.api.config.set({ showLunar: e.target.checked });
  });
  $('#showTodos').addEventListener('change', async (e) => {
    await window.api.config.set({ showTodos: e.target.checked });
  });
  $('#startWithSystem').addEventListener('change', async (e) => {
    await window.api.config.set({ startWithSystem: e.target.checked });
  });
  $$('input[name="weekStart"]').forEach(r => r.addEventListener('change', async (e) => {
    if (e.target.checked) await window.api.config.set({ weekStartsOn: Number(e.target.value) });
  }));
  $$('input[name="theme"]').forEach(r => r.addEventListener('change', async (e) => {
    if (e.target.checked) await window.api.config.set({ theme: e.target.value });
  }));

  $('#btnResetPos').addEventListener('click', async () => {
    if (!confirm('重置小组件位置到屏幕右上角？')) return;
    const cfg = await window.api.config.get();
    cfg.x = null; cfg.y = null;
    await window.api.config.set(cfg);
    alert('位置已重置，小组件已移到屏幕右上角。');
  });
  $('#btnClearDone').addEventListener('click', async () => {
    if (!confirm('删除所有已完成日程？此操作不可撤销。\n（重复日程不会被删除，避免误删整条规则）')) return;
    // 走 IPC：调 schedule:delete 一个个删；重复日程跳过（完成状态是按出现日记录的）
    const [y, m] = currentFilter.month.split('-').map(Number);
    const list = await window.api.schedule.list(y, m);
    const seen = new Set();
    for (const s of list) {
      if (s.isRecurring || (s.repeat && s.repeat !== 'none')) continue;
      if (s.done && !seen.has(s.id)) {
        seen.add(s.id);
        await window.api.schedule.remove(s.id);
      }
    }
    await renderSchedules();
  });
}

// ---------- 左侧：日程管理 ----------
async function renderSchedules() {
  const [y, m] = currentFilter.month.split('-').map(Number);
  const list = await window.api.schedule.list(y, m);

  const kw = currentFilter.keyword.trim().toLowerCase();
  const filtered = list.filter(s => {
    if (kw && !(s.title + (s.note || '')).toLowerCase().includes(kw)) return false;
    if (currentFilter.done === 'done'   && !s.done) return false;
    if (currentFilter.done === 'undone' &&  s.done) return false;
    return true;
  });

  // 重复日程按 id 合并：同一规则在本月只显示一行，附"共 N 次出现"标记，避免列表被 daily 撑爆。
  // 非重复日程每条独立显示。
  const merged = [];
  const seenRecurring = new Map();   // id → 在 merged 里的索引
  for (const s of filtered) {
    const isRec = s.isRecurring || (s.repeat && s.repeat !== 'none');
    if (isRec) {
      if (seenRecurring.has(s.id)) {
        const idx = seenRecurring.get(s.id);
        merged[idx].occCount += 1;
        merged[idx].occDates.push(s.occurrenceDate);
        continue;
      }
      seenRecurring.set(s.id, merged.length);
      merged.push({ ...s, occCount: 1, occDates: [s.occurrenceDate] });
    } else {
      merged.push({ ...s, occCount: 1, occDates: [s.occurrenceDate] });
    }
  }

  const html = merged.length === 0
    ? `<div class="t-row"><div></div><div></div><div style="color:var(--txt-faint);">暂无日程</div><div></div><div></div></div>`
    : merged.map(s => {
        const isRec = s.isRecurring || (s.repeat && s.repeat !== 'none');
        const time = s.start_time
          ? `${s.start_time}${s.end_time ? '-' + s.end_time : ''}`
          : '全天';
        // 重复日程：日期格显示范围（如 09-01 ~ 09-05），附出现次数
        const dateCell = isRec && s.occCount > 1
          ? `<span title="本月共 ${s.occCount} 次出现">${escapeText(s.occDates[0])} ~ ${escapeText(s.occDates[s.occDates.length - 1])} <span class="occ-count">×${s.occCount}</span></span>`
          : `${escapeText(s.occurrenceDate || s.date)}${isRec ? ' <span class="repeat-badge" title="重复日程">↻</span>' : ''}`;
        return `<div class="t-row ${s.done ? 'done' : ''}" data-id="${s.id}" data-occ="${s.occurrenceDate || s.date}">
          <div>${dateCell}</div>
          <div>${escapeText(time)}</div>
          <div class="title-cell" style="${s.color ? `--accent:${s.color}` : ''}">
            ${escapeText(s.title)}${s.note ? `<span style="color:var(--txt-faint);font-size:11px;margin-left:6px;">${escapeText(s.note)}</span>` : ''}
          </div>
          <div><span class="status-pill ${s.done ? 'done' : 'undone'}">${s.done ? '已完成' : '未完成'}</span></div>
          <div class="ops">
            <button data-act="toggle">${s.done ? '↺' : '✓'}</button>
            <button data-act="edit">编辑</button>
            <button data-act="del" class="del">删除</button>
          </div>
        </div>`;
      }).join('');
  $('#scheduleRows').innerHTML = html;

  $$('#scheduleRows .t-row').forEach(el => {
    const id = Number(el.dataset.id);
    if (!id) return;
    el.querySelector('[data-act="toggle"]').addEventListener('click', async () => {
      await window.api.schedule.toggleDone(id);
      renderSchedules();
    });
    el.querySelector('[data-act="edit"]').addEventListener('click', async () => {
      const all = await window.api.schedule.list(y, m);
      const s = all.find(x => x.id === id);
      if (s) openScheduleModal(s);
    });
    el.querySelector('[data-act="del"]').addEventListener('click', async () => {
      if (confirm('确认删除？')) {
        await window.api.schedule.remove(id);
        renderSchedules();
      }
    });
  });
}

// ---------- 待办 ----------
async function renderTodos() {
  const todos = await window.api.todo.list();
  $('#todoList').innerHTML = todos.map(t => `
    <li class="${t.done ? 'done' : ''}" data-id="${t.id}">
      <span class="check" data-act="toggle">✓</span>
      <span class="content">${escapeText(t.content)}</span>
      <button class="del" data-act="del" title="删除">✕</button>
    </li>
  `).join('') || '<li style="color:var(--txt-faint);font-size:12px;">暂无待办</li>';

  $$('#todoList li').forEach(el => {
    const id = Number(el.dataset.id);
    if (!id) return;
    el.querySelector('[data-act="toggle"]').addEventListener('click', async () => {
      const all = await window.api.todo.list();
      const t = all.find(x => x.id === id);
      await window.api.todo.update({ id, done: !t.done });
      renderTodos();
    });
    el.querySelector('[data-act="del"]').addEventListener('click', async () => {
      await window.api.todo.remove(id);
      renderTodos();
    });
  });
}

// ---------- 浮层：日程 ----------
function openScheduleModal(schedule = null) {
  editingId = schedule ? schedule.id : null;
  editingColor = schedule ? (schedule.color || '#ff6b6b') : '#ff6b6b';
  $('#scheduleModalTitle').textContent = schedule ? '编辑日程' : '新建日程';
  $('#fTitle').value = schedule ? schedule.title : '';
  $('#fDate').value  = schedule ? schedule.date : `${currentFilter.month}-01`;
  $('#fStart').value = schedule ? (schedule.start_time || '') : '';
  $('#fEnd').value   = schedule ? (schedule.end_time || '') : '';
  $('#fNote').value  = schedule ? (schedule.note || '') : '';
  $('#fRepeat').value = schedule ? (schedule.repeat || 'none') : 'none';
  $('#btnDeleteSchedule').hidden = !schedule;
  $$('#colorRow span').forEach(s => s.classList.toggle('active', s.dataset.c === editingColor));
  $('#scheduleModal').hidden = false;
  setTimeout(() => $('#fTitle').focus(), 30);
}
function closeScheduleModal() { $('#scheduleModal').hidden = true; editingId = null; }
async function saveSchedule() {
  const data = {
    title: $('#fTitle').value.trim(),
    date: $('#fDate').value,
    start_time: $('#fStart').value,
    end_time: $('#fEnd').value,
    note: $('#fNote').value.trim(),
    color: editingColor,
    repeat: $('#fRepeat').value || 'none',
  };
  if (!data.title) { alert('请输入标题'); return; }
  if (!data.date)  { alert('请选择日期'); return; }
  if (editingId) await window.api.schedule.update({ id: editingId, ...data });
  else await window.api.schedule.create(data);
  closeScheduleModal();
  // 自动跳转到该月
  currentFilter.month = data.date.substring(0, 7);
  $('#filterMonth').value = currentFilter.month;
  await renderSchedules();
}

// ---------- 启动 ----------
(async function init() {
  await loadConfigToUI();
  cfgCache = await window.api.config.get();   // 缓存初始 config（快捷键失败回退/同步用）
  bindConfigEvents();
  bindShortcutCapture();
  bindShortcutEvents();
  initColorSwatches();

  // 过滤
  $('#filterMonth').addEventListener('change', (e) => {
    currentFilter.month = e.target.value;
    renderSchedules();
  });
  $('#filterKeyword').addEventListener('input', (e) => {
    currentFilter.keyword = e.target.value;
    renderSchedules();
  });
  $('#filterDone').addEventListener('change', (e) => {
    currentFilter.done = e.target.value;
    renderSchedules();
  });

  // 新建
  $('#btnNewSchedule').addEventListener('click', () => openScheduleModal());

  // 浮层
  $('#btnCancelSchedule').addEventListener('click', closeScheduleModal);
  $('#btnSaveSchedule').addEventListener('click', saveSchedule);
  $('#btnDeleteSchedule').addEventListener('click', async () => {
    if (editingId && confirm('确认删除？')) {
      await window.api.schedule.remove(editingId);
      closeScheduleModal();
      renderSchedules();
    }
  });
  $$('#colorRow span').forEach(s => s.addEventListener('click', () => {
    editingColor = s.dataset.c;
    $$('#colorRow span').forEach(x => x.classList.toggle('active', x === s));
  }));
  $('#scheduleModal').addEventListener('click', (e) => {
    if (e.target.id === 'scheduleModal') closeScheduleModal();
  });

  // 待办
  $('#todoInput').addEventListener('keydown', async (e) => {
    if (e.key === 'Enter' && e.target.value.trim()) {
      await window.api.todo.create(e.target.value.trim());
      e.target.value = '';
      renderTodos();
    }
  });

  await renderSchedules();
  await renderTodos();
})();