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
  $$('input[name="weekStart"]').forEach(r => r.checked = (Number(r.value) === (cfg.weekStartsOn ?? 1)));
  $$('input[name="theme"]').forEach(r => r.checked = (r.value === (cfg.theme || 'glacier')));
  $('#filterMonth').value = todayMonth();
  currentFilter.month = $('#filterMonth').value;
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

  const html = filtered.length === 0
    ? `<div class="t-row"><div></div><div></div><div style="color:var(--txt-faint);">暂无日程</div><div></div><div></div></div>`
    : filtered.map(s => {
        const time = s.start_time
          ? `${s.start_time}${s.end_time ? '-' + s.end_time : ''}`
          : '全天';
        return `<div class="t-row ${s.done ? 'done' : ''}" data-id="${s.id}" data-occ="${s.occurrenceDate || s.date}">
          <div>${escapeText(s.date)}${s.isRecurring || (s.repeat && s.repeat !== 'none') ? ' <span class="repeat-badge" title="重复日程">↻</span>' : ''}</div>
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
  bindConfigEvents();

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