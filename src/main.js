/**
 * Electron 主进程
 *
 * 职责：
 *   1. 创建两个 BrowserWindow：
 *      - widget  : 透明无边框置顶的桌面小组件（仿图样式）
 *      - settings: 点击设置按钮弹出的独立可视化设置窗口
 *
 *   2. 暴露 IPC API 给渲染进程：
 *      schedule:*  → SQLite 增删改查
 *      config:*    → JSON 配置读写
 *      window:*    → 窗口控制（移动 / 缩放 / 透明度 / 置顶 / 显隐）
 *
 *   3. 系统托盘（Tray）作为控制中心：显示/隐藏、打开设置、退出
 *
 *   4. 全局快捷键：Ctrl+Shift+C 唤起/隐藏 widget
 */
const { app, BrowserWindow, ipcMain, Tray, Menu, globalShortcut, screen, nativeImage } = require('electron');

const path = require('path');
const fs = require('fs');

// ---------- 关键修复：透明窗口被遮挡后"看得见点不着" ----------
// Windows 上 Chromium 的原生窗口遮挡追踪（NativeWindowOcclusionTracker）对透明窗口有误判：
// 窗口被其他窗口盖过一次后可能被错误标记为"仍被遮挡"，于是停止渲染更新——
// 屏幕上残留最后一帧（看起来一切正常），但所有鼠标事件被丢弃（点了没反应）。
// 禁用该特性 + 后台节流，根治透明小组件"残影假死"问题。
app.commandLine.appendSwitch('disable-features', 'NativeWindowOcclusionTracker,CalculateNativeWinOcclusion');

// ---------- 单实例锁：防止重复双击把内存翻倍叠加 ----------
// 用户可能误双击多次或从托盘/快捷方式重复拉起；没锁的话会开多个 Electron 实例，
// 每实例自带一套 Chromium 进程（主+GPU+渲染≈100M），内存直接翻倍。
// 加锁后：第二个实例启动会拿到锁失败 → 自动退出并把焦点还给已运行实例。
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (widgetWin) { if (widgetWin.isMinimized()) widgetWin.restore(); widgetWin.show(); widgetWin.focus(); }
  });
}

const sqlite3 = require('node-sqlite3-wasm');
const { Database } = sqlite3;

// 日程重复规则（纯函数，便于单元测试）
const { matchesRepeat, expandMonth } = require('./repeat.js');

// ---------- 路径与目录 ----------
const APP_DIR = app.getAppPath();
const DATA_DIR = path.join(app.getPath('userData')); // C:\Users\xxx\AppData\Roaming\desktop-calendar
const DB_PATH = path.join(DATA_DIR, 'calendar.db');
const CONFIG_PATH = path.join(DATA_DIR, 'config.json');

// 首次运行时确保目录存在
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// ---------- 数据库（node-sqlite3-wasm，纯 WASM，零编译） ----------
const db = new Database(DB_PATH);
db.exec(`
  CREATE TABLE IF NOT EXISTS schedules (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    title       TEXT NOT NULL,
    note        TEXT DEFAULT '',
    date        TEXT NOT NULL,                -- YYYY-MM-DD
    start_time  TEXT DEFAULT '',              -- HH:MM（可空，全天事件）
    end_time    TEXT DEFAULT '',
    color       TEXT DEFAULT '#ff6b6b',       -- 列表上的左侧高亮色
    done        INTEGER DEFAULT 0,            -- 0/1
    created_at  TEXT DEFAULT (datetime('now','localtime'))
  );
  CREATE INDEX IF NOT EXISTS idx_date ON schedules(date);

  CREATE TABLE IF NOT EXISTS todos (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    content     TEXT NOT NULL,
    done        INTEGER DEFAULT 0,
    sort_order  INTEGER DEFAULT 0,
    created_at  TEXT DEFAULT (datetime('now','localtime'))
  );
`);

// 兼容旧库：补充 repeat 列（老版本没有）
try {
  const cols = db.all("PRAGMA table_info(schedules)");
  if (!cols.some((c) => (c.name || '').toLowerCase() === 'repeat')) {
    db.exec("ALTER TABLE schedules ADD COLUMN repeat TEXT NOT NULL DEFAULT 'none'");
  }
} catch (e) {
  console.error('[db] 检查/补充 repeat 列失败：', e);
}

// 重复日程的"单次完成"记录：schedules.done 对重复日程不再使用，
// 每个出现日（occurrence）独立记录是否完成
db.exec(`
  CREATE TABLE IF NOT EXISTS recurrence_done (
    schedule_id INTEGER NOT NULL,
    date        TEXT NOT NULL,           -- YYYY-MM-DD（occurrence 日期）
    done        INTEGER DEFAULT 1,
    PRIMARY KEY (schedule_id, date)
  );
`);

/**
 * 计算某条日程在某出现日的"生效完成状态"
 *  - 非重复日程 → schedules.done
 *  - 重复日程   → recurrence_done 有记录则取之，默认未完成
 */
function effectiveDone(s, occurrenceDate) {
  if (s.repeat && s.repeat !== 'none') {
    const row = db.get('SELECT done FROM recurrence_done WHERE schedule_id = ? AND date = ?', [s.id, occurrenceDate]);
    return row ? !!row.done : false;
  }
  return !!s.done;
}

// ---------- 配置 ----------
const DEFAULT_CONFIG = {
  // 窗口
  opacity: 0.92,
  alwaysOnTop: true,
  clickThrough: false,            // 鼠标穿透（勾选后只能右键关闭）
  width: 760,
  height: 900,
  // 位置（主屏居中）
  x: null,
  y: null,
  // 显示
  showLunar: true,
  showTodos: true,
  weekStartsOn: 1,               // 1=周一 0=周日
  theme: 'glacier',              // glacier / inkblot / rose
  // 系统
  startWithSystem: false,
};

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      return { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) };
    }
  } catch (e) {
    console.error('[config] 解析失败，使用默认：', e);
  }
  return { ...DEFAULT_CONFIG };
}
function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), 'utf8');
}
let config = loadConfig();

// ---------- 窗口 ----------
let widgetWin = null;
let settingsWin = null;
let tray = null;

function createWidgetWindow() {
  // 默认位置：主屏右上角偏内
  const display = screen.getPrimaryDisplay().workArea;
  const x = config.x ?? Math.round(display.x + display.width - config.width - 40);
  const y = config.y ?? Math.round(display.y + 40);

  widgetWin = new BrowserWindow({
    width: config.width,
    height: config.height,
    x, y,
    frame: false,
    transparent: true,
    resizable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: config.alwaysOnTop,
    hasShadow: false,
    backgroundColor: '#00000000',
    opacity: config.opacity,
    title: '桌面日历',
    icon: path.join(APP_DIR, 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(APP_DIR, 'src', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      devTools: true,
      backgroundThrottling: false,   // 透明小组件：被遮挡时也不要节流渲染/输入
    },
  });

  widgetWin.setIgnoreMouseEvents(config.clickThrough, { forward: true });
  widgetWin.loadFile(path.join(APP_DIR, 'src', 'widget.html'));

  // 被其他窗口盖过后重新显示时，主动回到最前，避免输入失效
  widgetWin.on('show', () => {
    if (!config.alwaysOnTop) widgetWin.moveTop();
  });

  // 同步位置
  const saveBounds = () => {
    if (!widgetWin) return;
    const b = widgetWin.getBounds();
    config.x = b.x;
    config.y = b.y;
    config.width = b.width;
    config.height = b.height;
    saveConfig(config);
  };
  widgetWin.on('move', saveBounds);
  widgetWin.on('resize', saveBounds);

  widgetWin.on('closed', () => { widgetWin = null; });
}

function createSettingsWindow() {
  if (settingsWin) {
    settingsWin.show();
    settingsWin.focus();
    return;
  }
  settingsWin = new BrowserWindow({
    width: 980,
    height: 720,
    minWidth: 880,
    minHeight: 600,
    title: '桌面日历 · 设置',
    icon: path.join(APP_DIR, 'assets', 'icon.png'),
    autoHideMenuBar: true,
    backgroundColor: '#0e1a2b',
    webPreferences: {
      preload: path.join(APP_DIR, 'src', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  settingsWin.loadFile(path.join(APP_DIR, 'src', 'settings.html'));
  settingsWin.on('closed', () => { settingsWin = null; });
}

// ---------- 托盘 ----------
/**
 * 生成托盘图标（32x32 RGBA bitmap，无需外部图像文件）
 * 样式：圆角矩形 + 顶部红色绑定条 + "日" 字
 */
function buildTrayIcon() {
  const size = 32;
  const buf = Buffer.alloc(size * size * 4);

  // 解析主题色（默认冰川蓝渐变 #4dabf7 → #69db7c）
  const theme = (config && config.theme) || 'glacier';
  const palettes = {
    glacier: { from: [77, 171, 247], to: [105, 219, 124] },   // 蓝 → 绿
    inkblot: { from: [95, 61, 196], to: [230, 73, 128] },     // 紫 → 粉
    rose:    { from: [255, 135, 135], to: [255, 169, 77] },   // 粉 → 橙
  };
  const p = palettes[theme] || palettes.glacier;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const t = y / size;
      const r = Math.round(p.from[0] + (p.to[0] - p.from[0]) * t);
      const g = Math.round(p.from[1] + (p.to[1] - p.from[1]) * t);
      const b = Math.round(p.from[2] + (p.to[2] - p.from[2]) * t);
      buf[i] = r; buf[i + 1] = g; buf[i + 2] = b; buf[i + 3] = 255;

      // 圆角：4 个角的距离
      const cornerDist = Math.min(x, y, size - 1 - x, size - 1 - y);
      if (cornerDist < 3) {
        buf[i + 3] = Math.round(255 * Math.max(0, cornerDist / 3));
      }

      // 顶部红色"装订条"（y = 2-5）
      if (y >= 2 && y <= 5 && x >= 4 && x <= size - 5) {
        buf[i] = 255; buf[i + 1] = 122; buf[i + 2] = 89; buf[i + 3] = 255;
      }

      // 中间白色"日"字（简化版：十字 + 一横）
      const cx = size / 2, cy = size / 2;
      const inHoriz = y >= 13 && y <= 18 && x >= 11 && x <= 20;
      const inVert  = x >= 14 && x <= 17 && y >= 11 && y <= 22;
      if (inHoriz || inVert) {
        buf[i] = 255; buf[i + 1] = 255; buf[i + 2] = 255; buf[i + 3] = 230;
      }
    }
  }

  return nativeImage.createFromBitmap(buf, { width: size, height: size });
}

function createTray() {
  tray = new Tray(buildTrayIcon());
  tray.setToolTip('桌面日历小组件');
  tray.setContextMenu(Menu.buildFromTemplate([
    {
      label: '显示/隐藏小组件',
      click: () => {
        if (!widgetWin) return createWidgetWindow();
        if (widgetWin.isVisible()) widgetWin.hide(); else widgetWin.show();
      },
    },
    { type: 'separator' },
    { label: '打开设置', click: () => createSettingsWindow() },
    {
      label: '穿透模式（右键关闭）',
      type: 'checkbox',
      checked: config.clickThrough,
      click: (item) => {
        config.clickThrough = item.checked;
        if (widgetWin) widgetWin.setIgnoreMouseEvents(config.clickThrough, { forward: true });
        saveConfig(config);
      },
    },
    {
      label: '窗口置顶',
      type: 'checkbox',
      checked: config.alwaysOnTop,
      click: (item) => {
        config.alwaysOnTop = item.checked;
        if (widgetWin) widgetWin.setAlwaysOnTop(config.alwaysOnTop);
        saveConfig(config);
      },
    },
    { type: 'separator' },
    { label: '退出', click: () => app.quit() },
  ]));
}

// ---------- IPC：日程 ----------
function notifyDataChanged() {
  if (widgetWin) widgetWin.webContents.send('data:changed');
  if (settingsWin && !settingsWin.isDestroyed()) settingsWin.webContents.send('data:changed');
}

ipcMain.handle('schedule:list', (_e, { year, month }) => {
  const start = `${year}-${String(month).padStart(2, '0')}-01`;
  const lastDay = new Date(year, month, 0).getDate();
  const end = `${year}-${String(month).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;

  // 非重复日程：按日期范围取
  const exact = db.all(
    'SELECT * FROM schedules WHERE date BETWEEN ? AND ? AND (repeat IS NULL OR repeat = ?) ORDER BY date, COALESCE(start_time,\'\'), id',
    [start, end, 'none']
  );
  // 重复日程：取全部，再展开成本月内的出现日
  const recurring = db.all("SELECT * FROM schedules WHERE repeat IS NOT NULL AND repeat <> ?", ['none']);

  const out = exact.map((s) => ({ ...s, occurrenceDate: s.date, isRecurring: false }));
  for (const s of recurring) {
    for (const occ of expandMonth(s.repeat, s.date, year, month)) {
      out.push({ ...s, occurrenceDate: occ, isRecurring: true });
    }
  }
  out.sort(sortSchedules);
  return out;
});

ipcMain.handle('schedule:listByDate', (_e, date) => {
  const exact = db.all(
    'SELECT * FROM schedules WHERE date = ? AND (repeat IS NULL OR repeat = ?) ORDER BY COALESCE(start_time,\'\'), id',
    [date, 'none']
  );
  const recurring = db.all("SELECT * FROM schedules WHERE repeat IS NOT NULL AND repeat <> ?", ['none']);

  const out = exact.map((s) => ({ ...s, occurrenceDate: s.date, isRecurring: false }));
  for (const s of recurring) {
    if (matchesRepeat(s.repeat, s.date, date)) {
      out.push({ ...s, occurrenceDate: date, isRecurring: true });
    }
  }
  for (const s of out) s.done = effectiveDone(s, s.occurrenceDate) ? 1 : 0;
  out.sort(sortSchedules);
  return out;
});

// 排序：按出现日 → 开始时间 → id
function sortSchedules(a, b) {
  if (a.occurrenceDate < b.occurrenceDate) return -1;
  if (a.occurrenceDate > b.occurrenceDate) return 1;
  const sa = a.start_time || '', sb = b.start_time || '';
  if (sa < sb) return -1;
  if (sa > sb) return 1;
  return a.id - b.id;
}

ipcMain.handle('schedule:create', (_e, data) => {
  const r = db.run(
    'INSERT INTO schedules (title, note, date, start_time, end_time, color, repeat) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [data.title, data.note || '', data.date, data.start_time || '', data.end_time || '', data.color || '#ff6b6b', data.repeat || 'none']
  );
  const row = db.get('SELECT * FROM schedules WHERE id = ?', [Number(r.lastInsertRowid)]);
  notifyDataChanged();
  return row;
});

ipcMain.handle('schedule:update', (_e, { id, ...data }) => {
  // 重复规则变化时，旧的单次完成记录已失效，一并清掉
  const old = db.get('SELECT repeat FROM schedules WHERE id = ?', [id]);
  if (old && (old.repeat || 'none') !== (data.repeat || 'none')) {
    db.run('DELETE FROM recurrence_done WHERE schedule_id = ?', [id]);
  }
  db.run(
    `UPDATE schedules SET title=:t, note=:n, date=:d, start_time=:s, end_time=:e, color=:c, done=:done, repeat=:r WHERE id=:id`,
    {
      ':t': data.title, ':n': data.note || '', ':d': data.date,
      ':s': data.start_time || '', ':e': data.end_time || '',
      ':c': data.color || '#ff6b6b', ':done': data.done ? 1 : 0,
      ':r': data.repeat || 'none', ':id': id
    }
  );
  const row = db.get('SELECT * FROM schedules WHERE id = ?', [id]);
  notifyDataChanged();
  return row;
});

ipcMain.handle('schedule:toggleDone', (_e, payload) => {
  // 兼容旧调用：直接传 id（数字）；新调用传 { id, occurrenceDate }
  const { id, occurrenceDate } =
    payload !== null && typeof payload === 'object' ? payload : { id: payload };
  const row = db.get('SELECT * FROM schedules WHERE id = ?', [id]);
  if (!row) return null;

  // 重复日程：按出现日独立记录完成状态
  if (row.repeat && row.repeat !== 'none' && occurrenceDate) {
    const cur = db.get('SELECT done FROM recurrence_done WHERE schedule_id = ? AND date = ?', [id, occurrenceDate]);
    const next = (cur && cur.done) ? 0 : 1;
    if (cur) {
      db.run('UPDATE recurrence_done SET done = ? WHERE schedule_id = ? AND date = ?', [next, id, occurrenceDate]);
    } else {
      db.run('INSERT INTO recurrence_done (schedule_id, date, done) VALUES (?, ?, ?)', [id, occurrenceDate, next]);
    }
    notifyDataChanged();
    return next;
  }

  const next = row.done ? 0 : 1;
  db.run('UPDATE schedules SET done = ? WHERE id = ?', [next, id]);
  notifyDataChanged();
  return next;
});

ipcMain.handle('schedule:delete', (_e, id) => {
  db.run('DELETE FROM schedules WHERE id = ?', [id]);
  db.run('DELETE FROM recurrence_done WHERE schedule_id = ?', [id]); // 清理单次完成记录
  notifyDataChanged();
  return true;
});

// ---------- IPC：待办 ----------
ipcMain.handle('todo:list', () => db.all('SELECT * FROM todos ORDER BY sort_order, id'));
ipcMain.handle('todo:create', (_e, { content }) => {
  const row = db.get('SELECT COALESCE(MAX(sort_order), 0) AS m FROM todos');
  const r = db.run('INSERT INTO todos (content, sort_order) VALUES (?, ?)', [content, row.m + 1]);
  const created = db.get('SELECT * FROM todos WHERE id = ?', [Number(r.lastInsertRowid)]);
  notifyDataChanged();
  return created;
});
ipcMain.handle('todo:update', (_e, { id, content, done }) => {
  // 用命名参数 + COALESCE，undefined 不更新该字段
  db.run(
    `UPDATE todos SET content = COALESCE(:c, content), done = COALESCE(:d, done) WHERE id = :id`,
    {
      ':c': content ?? null,
      ':d': done === undefined ? null : (done ? 1 : 0),
      ':id': id,
    }
  );
  const row = db.get('SELECT * FROM todos WHERE id = ?', [id]);
  notifyDataChanged();
  return row;
});
ipcMain.handle('todo:delete', (_e, id) => {
  db.run('DELETE FROM todos WHERE id = ?', [id]);
  notifyDataChanged();
  return true;
});

// ---------- IPC：配置 ----------
ipcMain.handle('config:get', () => config);
ipcMain.handle('config:set', (_e, partial) => {
  config = { ...config, ...partial };
  saveConfig(config);
  // 即时生效到 widget
  if (widgetWin) {
    if (partial.opacity !== undefined) widgetWin.setOpacity(partial.opacity);
    if (partial.alwaysOnTop !== undefined) widgetWin.setAlwaysOnTop(!!partial.alwaysOnTop);
    if (partial.clickThrough !== undefined) widgetWin.setIgnoreMouseEvents(!!partial.clickThrough, { forward: true });
    // 重置位置：x/y 传 null 时立即移回屏幕右上角默认位置
    if (partial.x === null || partial.y === null) {
      const display = screen.getPrimaryDisplay().workArea;
      const b = widgetWin.getBounds();
      widgetWin.setBounds({
        x: display.x + display.width - b.width - 40,
        y: display.y + 40,
        width: b.width, height: b.height,
      });
    }
    // 宽/高可能分开传（设置窗两个独立滑块），各自独立生效，缺省维度沿用当前值
    if (partial.width !== undefined || partial.height !== undefined) {
      const b = widgetWin.getBounds();
      widgetWin.setBounds({
        x: b.x, y: b.y,
        width:  partial.width  !== undefined ? partial.width  : b.width,
        height: partial.height !== undefined ? partial.height : b.height,
      });
    }
    // 广播：让渲染进程自行决定重读 config 或重渲染
    widgetWin.webContents.send('config:changed', config);
  }
  // 通知设置窗口刷新（设置窗口虽然自己保存，但保持同步）
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.webContents.send('config:changed', config);
  }

  // 开机自启
  if ('startWithSystem' in partial) applyAutoStart();

  // 主题变化时刷新托盘图标
  if ('theme' in partial && tray) tray.setImage(buildTrayIcon());

  return config;
});

/**
 * 同步开机自启动状态到系统
 * Windows / macOS：app.setLoginItemSettings
 * Linux：未实现（需要 .desktop + XDG autostart）
 */
function applyAutoStart() {
  if (process.platform === 'win32' || process.platform === 'darwin') {
    app.setLoginItemSettings({
      openAtLogin: !!config.startWithSystem,
      // Windows 打包后 path 自动是 exe；开发模式下用 electron.exe + main.js 路径
      ...(process.platform === 'win32' && !app.isPackaged
          ? { path: process.execPath, args: [path.join(APP_DIR, 'src', 'main.js')] }
          : {}),
    });
  }
  // Linux 暂不支持
}

// 监听 IPC：配置变更广播（如果设置/其他来源触发 config 变化，需要 widget 同步）
ipcMain.on('config:broadcast', () => {
  if (widgetWin) widgetWin.webContents.send('config:changed', config);
});

// ---------- IPC：无边框窗口边缘拖拽缩放 ----------
// Windows 上 frameless 窗口没有系统 resize 手柄，这里用渲染层热区 + IPC 模拟
const RESIZE_MIN = { w: 520, h: 600 };   // 与设置窗滑块下限一致
let resizeCtx = null;                    // { edge, startBounds, startMouse }

ipcMain.on('widget:resizeStart', (_e, edge, sx, sy) => {
  if (!widgetWin || widgetWin.isDestroyed()) return;
  resizeCtx = { edge, startBounds: widgetWin.getBounds(), startMouse: { x: sx, y: sy } };
});
ipcMain.on('widget:resizeMove', (_e, sx, sy) => {
  if (!resizeCtx || !widgetWin || widgetWin.isDestroyed()) return;
  const { edge, startBounds: b, startMouse: m } = resizeCtx;
  const dx = sx - m.x, dy = sy - m.y;
  let { x, y, width, height } = b;
  if (edge.includes('e')) width = b.width + dx;                     // 右缘：右缘跟鼠标
  if (edge.includes('s')) height = b.height + dy;                   // 下缘：下缘跟鼠标
  if (edge.includes('w')) { x = b.x + dx; width = b.width - dx; }   // 左缘：左缘跟鼠标，右缘钉住
  if (edge.includes('n')) { y = b.y + dy; height = b.height - dy; } // 上缘：上缘跟鼠标，下缘钉住
  // 最小尺寸钳制（w/n 方向要把钉住的边算对）
  if (width < RESIZE_MIN.w) {
    if (edge.includes('w')) x = b.x + b.width - RESIZE_MIN.w;
    width = RESIZE_MIN.w;
  }
  if (height < RESIZE_MIN.h) {
    if (edge.includes('n')) y = b.y + b.height - RESIZE_MIN.h;
    height = RESIZE_MIN.h;
  }
  widgetWin.setBounds({
    x: Math.round(x), y: Math.round(y),
    width: Math.round(width), height: Math.round(height),
  });
});
ipcMain.on('widget:resizeEnd', () => {
  if (resizeCtx && widgetWin && !widgetWin.isDestroyed()) {
    const b = widgetWin.getBounds();
    config.width = b.width; config.height = b.height;
    config.x = b.x; config.y = b.y;   // 位置也一并落盘，重启后保持
    saveConfig(config);
  }
  resizeCtx = null;
});

// ---------- IPC：窗口控制 ----------
ipcMain.handle('window:close', () => widgetWin?.close());
ipcMain.handle('window:hide', () => widgetWin?.hide());
ipcMain.handle('window:openSettings', () => createSettingsWindow());
ipcMain.handle('window:toggleDevTools', () => widgetWin?.webContents.toggleDevTools());

// ---------- 生命周期 ----------
let notifyTimer = null;
let notifiedToday = new Set();        // 已通知过的日程 id（每次跨天清空）
let notifiedDay = '';                 // 上次通知检查时的"今天"，跨天则清空

/**
 * 扫描今日日程，对 start_time 已到但未完成、未通知过的弹 Notification
 * 每分钟跑一次
 */
function checkReminders() {
  const today = fmtToday();
  const now = fmtNowHM();

  if (today !== notifiedDay) {
    notifiedDay = today;
    notifiedToday.clear();
  }

  const rows = db.all(
    `SELECT * FROM schedules WHERE (date = ? OR repeat <> 'none') AND done = 0 AND start_time != '' ORDER BY start_time`,
    [today]
  );

  for (const s of rows) {
    if (notifiedToday.has(s.id)) continue;
    // 重复日程：今天必须命中其规则才提醒，且该出现日未完成
    if (s.repeat && s.repeat !== 'none') {
      if (!matchesRepeat(s.repeat, s.date, today)) continue;
      if (effectiveDone(s, today)) continue;
    } else if (s.done) {
      continue;   // 非重复日程：已完成的不提醒
    }
    if (s.start_time > now) continue;    // 还没到时间

    notifiedToday.add(s.id);
    showNotification(s);
  }
}

function fmtToday() {
  const t = new Date();
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
}
function fmtNowHM() {
  const t = new Date();
  return `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`;
}

function showNotification(s) {
  const time = s.start_time + (s.end_time ? '-' + s.end_time : '');
  const n = new Notification({
    title: `📅 ${time}  ${s.title}`,
    body: s.note || '点击打开小组件查看',
    silent: false,
    urgency: 'normal',
  });
  n.on('click', () => {
    // 点击通知：显示 widget 并切到该日详情
    if (!widgetWin) createWidgetWindow();
    if (!widgetWin.isVisible()) widgetWin.show();
    widgetWin.focus();
    widgetWin.webContents.send('schedule:focus', s.date, s.id);
  });
  n.show();
}

app.whenReady().then(() => {
  console.log('[boot] app ready, creating windows...');
  createWidgetWindow();
  createTray();

  // 应用开机自启设置
  applyAutoStart();

  // 全局快捷键：Ctrl+Shift+C 切换小组件显示
  globalShortcut.register('CommandOrControl+Shift+C', () => {
    if (!widgetWin) return createWidgetWindow();
    if (widgetWin.isVisible()) widgetWin.hide(); else widgetWin.show();
  });

  // 启动日程提醒轮询（每 30 秒检查一次）
  checkReminders();
  notifyTimer = setInterval(checkReminders, 30 * 1000);

  // 内存诊断：启动后延迟几秒（等渲染进程稳定），打印各进程占用，便于真机核对
  setTimeout(() => printMemoryMetrics(), 4000);
});

/**
 * 打印当前各进程的内存占用（MB）。用于诊断 Electron 运行时内存构成。
 * 真机查看方式：打包版跑起来后用任务管理器；开发模式控制台或 --enable-logging。
 */
function printMemoryMetrics() {
  try {
    const rows = app.getAppMetrics().map((m) => {
      const name = (m.type || m.name || '?').padEnd(12);
      const mb = (m.memory ? m.memory.workingSetSize : 0) / 1024 / 1024;
      return `  ${name} ${mb.toFixed(1)} MB`;
    });
    const total = app.getAppMetrics().reduce((s, m) => s + ((m.memory ? m.memory.workingSetSize : 0) / 1024 / 1024), 0);
    console.log(`[mem] === 进程内存构成（合计 ${total.toFixed(0)} MB）===`);
    console.log('[mem]' + rows.join('\n[mem]'));
  } catch (e) {
    console.log('[mem] 无法读取指标：', e && e.message);
  }
}

app.on('window-all-closed', (e) => {
  // 不要退出，托盘要保留
  e.preventDefault?.();
});
app.on('before-quit', () => {
  globalShortcut.unregisterAll();
  if (notifyTimer) { clearInterval(notifyTimer); notifyTimer = null; }
  try { db.close(); } catch {}
});
app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});