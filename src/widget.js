/**
 * widget.js — 桌面日历小组件主逻辑
 *
 * 功能：
 *   - 渲染月历（含农历/节日/节气）
 *   - 渲染待办列表（持久化）
 *   - 日程增删改查（点击日期后展开详情）
 *   - 顶部按钮：上一月/今天/下一月/设置/穿透切换/隐藏/关闭
 *   - 同步配置（透明度/置顶/穿透）到主进程
 */
'use strict';

// ---------- 全局状态 ----------
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

let state = {
  year: 0,
  month: 0,         // 1-12
  selected: null,   // YYYY-MM-DD
  todayStr: '',
  config: null,
};

// ---------- 工具 ----------
function pad2(n) { return String(n).padStart(2, '0'); }
function fmtDate(y, m, d) { return `${y}-${pad2(m)}-${pad2(d)}`; }
function todayLocal() {
  const t = new Date();
  return { y: t.getFullYear(), m: t.getMonth() + 1, d: t.getDate() };
}

// 给弹窗里"颜色"色板（#colorRow span[data-c]）一次性写入 inline background，
// 避免 CSS 缺 background-color 导致 7 个圆点全透明（截图里只剩 .active 描边）。
function initColorSwatches() {
  $$('#colorRow span').forEach(s => {
    const c = s.dataset.c;
    if (c) s.style.backgroundColor = c;
  });
}
function fmtTodayStr() {
  const t = todayLocal();
  return fmtDate(t.y, t.m, t.d);
}

// ---------- 渲染：星期表头 ----------
function renderWeekdays(weekStartsOn) {
  const labels = ['周一','周二','周三','周四','周五','周六','周日'];
  const arr = weekStartsOn === 0 ? [...labels.slice(6), ...labels.slice(0, 6)] : labels;
  $('#weekdays').innerHTML = arr.map((w, i) => {
    const isWeekend = (weekStartsOn === 0 ? i === 0 || i === 6 : i === 5 || i === 6);
    return `<div class="wd ${isWeekend ? 'we' : ''}">${w}</div>`;
  }).join('');
}

// ---------- 渲染：月历网格 ----------
// 月份副标题：显示今天的农历日期，若有节日/节气一并带上
function renderMonthMeta() {
  const el = $('#monthMeta');
  if (!el) return;
  const [y, m, d] = state.todayStr.split('-').map(Number);
  const info = window.Lunar.getInfo(y, m, d);
  if (!info || !info.lunarText) { el.textContent = ''; return; }
  const bits = ['今日 ' + info.lunarText];
  if (info.solarText) bits.push(info.solarText);
  if (info.solarTerm) bits.push(info.solarTerm);
  el.textContent = bits.join(' · ');
}

async function renderCalendar() {
  const { year, month } = state;
  $('#monthTitle').textContent = `${year} 年 ${month} 月`;
  renderMonthMeta();

  // 当月第一天、当月天数、上月天数
  const firstDay = new Date(year, month - 1, 1);
  const lastDay  = new Date(year, month, 0);
  const daysInMonth = lastDay.getDate();
  const prevMonthLastDay = new Date(year, month - 1, 0).getDate();

  // weekStartsOn: 0=Sun, 1=Mon
  const weekStartsOn = state.config.weekStartsOn ?? 1;
  // 把 getDay() (0=Sun) 转成我们的 0=Mon 基准
  let firstWeekday = firstDay.getDay();           // 0=Sun
  firstWeekday = (firstWeekday - weekStartsOn + 7) % 7;

  // 拉当月日程（含重复日程展开后的出现日，按 occurrenceDate 分组）
  const list = await window.api.schedule.list(year, month);
  const byDate = {};
  for (const s of list) {
    (byDate[s.occurrenceDate] ||= []).push(s);
  }

  // 构建 42 个格子（6 行 × 7 列）
  const cells = [];
  // 上月填充
  for (let i = 0; i < firstWeekday; i++) {
    const d = prevMonthLastDay - firstWeekday + 1 + i;
    const py = month === 1 ? year - 1 : year;
    const pm = month === 1 ? 12 : month - 1;
    cells.push({ y: py, m: pm, d, otherMonth: true });
  }
  // 当月
  for (let d = 1; d <= daysInMonth; d++) {
    cells.push({ y: year, m: month, d, otherMonth: false });
  }
  // 下月填充到 42
  while (cells.length < 42) {
    const last = cells[cells.length - 1];
    let ny = last.y, nm = last.m, nd = last.d + 1;
    if (nd > new Date(ny, nm, 0).getDate()) { nd = 1; nm++; if (nm > 12) { nm = 1; ny++; } }
    cells.push({ y: ny, m: nm, d: nd, otherMonth: true });
  }

  $('#days').innerHTML = cells.map(c => renderDayCell(c, byDate[fmtDate(c.y, c.m, c.d)] || [])).join('');

  // 绑定点击
  $$('#days .day').forEach(el => {
    el.addEventListener('click', () => {
      const date = el.dataset.date;
      state.selected = date;
      $$('#days .day').forEach(d => d.classList.toggle('selected', d.dataset.date === date));
      renderDayDetail();
    });
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      // 右键直接弹出"添加日程"
      openScheduleModal(el.dataset.date);
    });
  });
}

function renderDayCell(c, events) {
  const dateStr = fmtDate(c.y, c.m, c.d);
  const isToday = dateStr === state.todayStr;
  const isSelected = dateStr === state.selected;
  const info = window.Lunar.getInfo(c.y, c.m, c.d);
  const isWeekend = new Date(c.y, c.m - 1, c.d).getDay() === 0 || new Date(c.y, c.m - 1, c.d).getDay() === 6;

  const lunarCls = info.primary.type === 'holiday' ? 'day-lunar holiday'
                 : info.primary.type === 'solar'   ? 'day-lunar solar'
                 : 'day-lunar';

  const eventHtml = events.slice(0, 2).map(e => {
    const time = e.start_time ? `${e.start_time} ` : '';
    const rep = (e.isRecurring || (e.repeat && e.repeat !== 'none')) ? '<span class="repeat-badge" title="重复日程">↻</span>' : '';
    return `<div class="day-event ${e.done ? 'done' : ''}" style="${e.color ? `--accent:${e.color}` : ''}" title="${escapeAttr(e.title)}">
              ${rep}${time}${escapeText(e.title)}
            </div>`;
  }).join('');
  const moreHtml = events.length > 2 ? `<div class="day-event-more">+${events.length - 2} 更多</div>` : '';

  return `<div class="day ${c.otherMonth ? 'other-month' : ''} ${isToday ? 'today' : ''} ${isSelected ? 'selected' : ''}"
               data-date="${dateStr}">
    <div class="day-head">
      <div class="day-num ${isWeekend ? 'we' : ''}">${c.d}</div>
      <div class="${lunarCls}" title="${escapeAttr(info.primary.text)}">${escapeText(info.primary.text)}</div>
    </div>
    <div class="day-events">
      ${eventHtml}${moreHtml}
    </div>
  </div>`;
}

// ---------- 渲染：当日详情 ----------
async function renderDayDetail() {
  if (!state.selected) {
    $('#dayDetail').hidden = true;
    return;
  }
  const [y, m, d] = state.selected.split('-').map(Number);
  const info = window.Lunar.getInfo(y, m, d);
  const dow = ['日','一','二','三','四','五','六'][new Date(y, m - 1, d).getDay()];

  $('#detailDate').textContent = `${y} 年 ${m} 月 ${d} 日 · 周${dow}`;
  $('#detailLunar').textContent = info.lunarText + (info.solarText ? ' · ' + info.solarText : '') + (info.solarTerm ? ' · ' + info.solarTerm : '');

  const schedules = await window.api.schedule.byDate(state.selected);
  const html = schedules.length === 0
    ? `<li style="color:var(--txt-faint);font-size:12px;padding:8px 4px;">这一天还没有日程，点上方"+ 添加日程"开始记录。</li>`
    : schedules.map(s => {
        const time = s.start_time
          ? `${s.start_time}${s.end_time ? '-' + s.end_time : ''}`
          : '全天';
        return `<li class="schedule-item ${s.done ? 'done' : ''}" data-id="${s.id}" data-occ="${s.occurrenceDate || s.date}">
          <div class="schedule-time">${escapeText(time)}${s.isRecurring || (s.repeat && s.repeat !== 'none') ? ' <span class="repeat-badge" title="重复日程">↻</span>' : ''}</div>
          <div class="schedule-title">${escapeText(s.title)}${s.note ? `<span style="color:var(--txt-faint);font-size:11px;margin-left:6px;">${escapeText(s.note)}</span>` : ''}</div>
          <div class="schedule-actions">
            <button data-act="toggle">${s.done ? '↺' : '✓'}</button>
            <button data-act="edit">编辑</button>
            <button data-act="del" class="del">删除</button>
          </div>
        </li>`;
      }).join('');
  $('#scheduleList').innerHTML = html;

  $$('#scheduleList .schedule-item').forEach(el => {
    const id = Number(el.dataset.id);
    const occ = el.dataset.occ;
    el.querySelector('[data-act="toggle"]').addEventListener('click', async () => {
      await window.api.schedule.toggleDone(id, occ);
      renderDayDetail();
    });
    el.querySelector('[data-act="edit"]').addEventListener('click', async () => {
      const all = await window.api.schedule.byDate(state.selected);
      const s = all.find(x => x.id === id);
      if (s) openScheduleModal(state.selected, s);
    });
    el.querySelector('[data-act="del"]').addEventListener('click', async () => {
      if (confirm('确认删除该日程？')) {
        await window.api.schedule.remove(id);
        renderDayDetail();
        renderCalendar();
      }
    });
  });

  $('#dayDetail').hidden = false;
}

// ---------- 浮层：添加/编辑日程 ----------
let editingId = null;
let editingColor = '#ff6b6b';

function openScheduleModal(date, schedule = null) {
  editingId = schedule ? schedule.id : null;
  editingColor = schedule ? (schedule.color || '#ff6b6b') : '#ff6b6b';
  $('#scheduleModalTitle').textContent = schedule ? '编辑日程' : '添加日程';
  $('#fTitle').value = schedule ? schedule.title : '';
  $('#fDate').value = schedule ? schedule.date : (date || state.selected || state.todayStr);
  $('#fStart').value = schedule ? schedule.start_time || '' : '';
  $('#fEnd').value = schedule ? schedule.end_time || '' : '';
  $('#fNote').value = schedule ? schedule.note || '' : '';
  $('#fRepeat').value = schedule ? (schedule.repeat || 'none') : 'none';
  $('#btnDeleteSchedule').hidden = !schedule;
  $$('#colorRow span').forEach(s => s.classList.toggle('active', s.dataset.c === editingColor));
  $('#scheduleModal').hidden = false;
  setTimeout(() => $('#fTitle').focus(), 30);
}
function closeScheduleModal() {
  $('#scheduleModal').hidden = true;
  editingId = null;
}

// ---------- 待办 ----------
async function renderTodos() {
  const todos = await window.api.todo.list();
  $('#todoList').innerHTML = todos.map(t => `
    <li class="todo-item ${t.done ? 'done' : ''}" data-id="${t.id}">
      <span class="todo-check" data-act="toggle">✓</span>
      <span class="todo-text">${escapeText(t.content)}</span>
      <button class="todo-del" data-act="del" title="删除">✕</button>
    </li>
  `).join('') || '<li style="color:var(--txt-faint);font-size:12px;padding:6px;">暂无待办，输入内容回车添加</li>';

  $$('#todoList .todo-item').forEach(el => {
    const id = Number(el.dataset.id);
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

// ---------- 转义 ----------
function escapeText(s) { return String(s ?? '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])); }
function escapeAttr(s) { return escapeText(s).replace(/"/g, '&quot;'); }

// ---------- 事件绑定 ----------
function bindEvents() {
  // 边缘拖拽缩放（无边框窗口）：按下手柄记录起点，pointermove 持续上报屏幕坐标。
  // 用 setPointerCapture：即使拖出窗口外松手，pointerup 仍会送达，不会卡在缩放状态
  $$('.rz').forEach((el) => {
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      try { el.setPointerCapture(e.pointerId); } catch (_) {}
      window.api.resize.start(el.dataset.edge, e.screenX, e.screenY);
      const onMove = (ev) => window.api.resize.move(ev.screenX, ev.screenY);
      const onUp = () => {
        el.removeEventListener('pointermove', onMove);
        el.removeEventListener('pointerup', onUp);
        el.removeEventListener('pointercancel', onUp);
        window.api.resize.end();
      };
      el.addEventListener('pointermove', onMove);
      el.addEventListener('pointerup', onUp);
      el.addEventListener('pointercancel', onUp);
    });
  });
  // 保险：窗口失焦（如拖拽中弹窗/切窗）立即结束缩放
  window.addEventListener('blur', () => window.api.resize.end());

  // 月份切换
  $('#btnPrev').addEventListener('click', () => moveMonth(-1));
  $('#btnNext').addEventListener('click', () => moveMonth(1));
  $('#btnToday').addEventListener('click', () => {
    const t = todayLocal();
    state.year = t.y; state.month = t.m;
    state.selected = state.todayStr;
    renderCalendar();
    renderDayDetail();
  });
  $('#btnSettings').addEventListener('click', () => window.api.window.openSettings());
  $('#btnToggle').addEventListener('click', async () => {
    const cfg = await window.api.config.get();
    const next = !cfg.clickThrough;
    await window.api.config.set({ clickThrough: next });
    showHint(next ? '已开启鼠标穿透（右键退出）' : '已关闭鼠标穿透');
  });
  $('#btnHide').addEventListener('click', () => window.api.window.hide());
  $('#btnClose').addEventListener('click', () => window.api.window.close());

  // 待办输入
  $('#todoInput').addEventListener('keydown', async (e) => {
    if (e.key === 'Enter' && e.target.value.trim()) {
      await window.api.todo.create(e.target.value.trim());
      e.target.value = '';
      renderTodos();
    }
  });

  // 详情
  $('#btnAddSchedule').addEventListener('click', () => openScheduleModal(state.selected));
  $('#btnCloseDetail').addEventListener('click', () => {
    state.selected = null;
    $$('#days .day').forEach(d => d.classList.remove('selected'));
    $('#dayDetail').hidden = true;
  });

  // 浮层
  $('#btnCancelSchedule').addEventListener('click', closeScheduleModal);
  $('#btnSaveSchedule').addEventListener('click', saveSchedule);
  $('#btnDeleteSchedule').addEventListener('click', async () => {
    if (editingId && confirm('确认删除？')) {
      await window.api.schedule.remove(editingId);
      closeScheduleModal();
      renderCalendar();
      renderDayDetail();
    }
  });
  $$('#colorRow span').forEach(s => s.addEventListener('click', () => {
    editingColor = s.dataset.c;
    $$('#colorRow span').forEach(x => x.classList.toggle('active', x === s));
  }));
  $('#scheduleModal').addEventListener('click', (e) => {
    if (e.target.id === 'scheduleModal') closeScheduleModal();
  });
}

async function saveSchedule() {
  const data = {
    title: $('#fTitle').value.trim(),
    date: $('#fDate').value,
    start_time: $('#fStart').value,
    end_time: $('#fEnd').value,
    note: $('#fNote').value.trim(),
    color: editingColor,
    repeat: $('#fRepeat').value,
  };
  if (!data.title) { alert('请输入标题'); return; }
  if (!data.date)  { alert('请选择日期'); return; }
  if (editingId) {
    await window.api.schedule.update({ id: editingId, ...data });
  } else {
    await window.api.schedule.create(data);
    state.selected = data.date;
    $$('#days .day').forEach(d => d.classList.toggle('selected', d.dataset.date === data.date));
  }
  closeScheduleModal();
  renderCalendar();
  renderDayDetail();
}

function moveMonth(delta) {
  let { year, month } = state;
  month += delta;
  if (month < 1)  { month = 12; year--; }
  if (month > 12) { month = 1;  year++; }
  state.year = year;
  state.month = month;
  renderCalendar();
  // 切换月后清掉 selected（除非它仍在本月）
  if (state.selected) {
    const [y, m] = state.selected.split('-').map(Number);
    if (y !== year || m !== month) {
      state.selected = null;
      $('#dayDetail').hidden = true;
    }
  }
}

// ---------- 提示气泡 ----------
let hintTimer = null;
function showHint(text) {
  let el = $('#hint');
  if (!el) {
    el = document.createElement('div');
    el.id = 'hint';
    el.style.cssText = `
      position: fixed; left: 50%; top: 50px; transform: translateX(-50%);
      padding: 6px 14px; border-radius: 8px;
      background: rgba(0,0,0,0.75); color: #fff;
      font-size: 12px; z-index: 200;
      border: 1px solid rgba(255,255,255,0.2);
      backdrop-filter: blur(10px);
      opacity: 0; transition: opacity .2s;
    `;
    document.body.appendChild(el);
  }
  el.textContent = text;
  el.style.opacity = '1';
  clearTimeout(hintTimer);
  hintTimer = setTimeout(() => { el.style.opacity = '0'; }, 1600);
}

// ---------- 启动 ----------
(async function init() {
  state.config = await window.api.config.get();
  state.todayStr = fmtTodayStr();
  const t = todayLocal();
  state.year = t.y;
  state.month = t.m;
  state.selected = state.todayStr;

  renderWeekdays(state.config.weekStartsOn ?? 1);
  initColorSwatches();
  bindEvents();
  await renderCalendar();
  await renderDayDetail();
  await renderTodos();

  applyConfigToUI();

  // 监听主进程推送的配置变更
  window.api.config.onChange(async (cfg) => {
    state.config = cfg;
    applyConfigToUI();
    renderWeekdays(cfg.weekStartsOn ?? 1);
    await renderCalendar();
    if (state.selected) await renderDayDetail();
  });

  // 监听数据变化（来自设置窗口或其他地方）
  window.api.data.onChange(async () => {
    await renderCalendar();
    if (state.selected) await renderDayDetail();
    await renderTodos();
  });

  // 监听通知点击：跳转到对应日期
  window.api.schedule.onFocus(async (date, scheduleId) => {
    const [y, m, d] = date.split('-').map(Number);
    if (state.year !== y || state.month !== m) {
      state.year = y; state.month = m;
    }
    state.selected = date;
    await renderCalendar();
    await renderDayDetail();
    // 滚动详情到对应日程
    if (scheduleId) {
      setTimeout(() => {
        const el = document.querySelector(`.schedule-item[data-id="${scheduleId}"]`);
        if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }, 100);
    }
  });
})();

function applyConfigToUI() {
  const cfg = state.config;
  document.body.dataset.theme = cfg.theme || 'glacier';
  document.querySelector('.todos-card').style.display = cfg.showTodos === false ? 'none' : '';

  // 农历开关：关闭后隐藏日期格上的农历 / 节气 / 节日，以及月份副标题
  const showLunar = cfg.showLunar !== false;
  document.body.classList.toggle('no-lunar', !showLunar);
  const meta = $('#monthMeta');
  if (meta) meta.style.display = showLunar ? '' : 'none';
}