/**
 * scripts/pack.js — 离线打包（零下载）
 *
 * 背景：electron-builder 在本机需要下载 electron / NSIS / winCodeSign 二进制，
 *       受 SSL 拦截影响会 socket hang up。本脚本绕过全部网络请求：
 *       直接复用 node_modules/electron/dist 里已装好的 Electron 运行时，
 *       把自己的代码塞进 resources/app，产出可双击运行的桌面程序目录。
 *
 * 产物：dist/桌面日历-win32-x64/桌面日历.exe
 *
 * 用法：npm run pack
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const ELECTRON_DIST = path.join(ROOT, 'node_modules', 'electron', 'dist');
const OUT_ROOT = path.join(ROOT, 'dist');
const APP_NAME = '桌面日历';
const OUT_DIR = path.join(OUT_ROOT, `${APP_NAME}-win32-x64`);
const APP_OUT = path.join(OUT_DIR, 'resources', 'app');

function log(msg) {
  console.log(`[pack] ${msg}`);
}

function dirSize(dir) {
  let total = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) total += dirSize(p);
    else total += fs.statSync(p).size;
  }
  return total;
}

function mb(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function rmIfExists(target) {
  if (!fs.existsSync(target)) return;
  try {
    fs.rmSync(target, { recursive: true, force: true });
  } catch (e) {
    // 沙箱/安全策略可能拦截批量删除：改名让路，不阻塞打包。
    // 旧目录留作 .bak-<时间戳>，用户可手动清理。
    const bak = `${target}.bak-${Date.now()}`;
    console.warn(`[pack] 删除旧目录失败（${e.code || e.message}），改为重命名让路：${bak}`);
    fs.renameSync(target, bak);
  }
}

/**
 * 分块复制单个文件。
 * 不用 fs.copyFileSync / fs.cpSync —— 在本项目的沙箱环境里它们会静默失败：
 * 目录建了，但文件内容一个字节都没写进去。这里改用 openSync + readSync + writeSync，
 * 已验证可靠；分块是为了避免 180MB 的 electron.exe 一次性占满内存。
 */
function copyFileChunked(src, dst, chunkSize) {
  const fdSrc = fs.openSync(src, 'r');
  const fdDst = fs.openSync(dst, 'w');
  try {
    const size = fs.fstatSync(fdSrc).size;
    const buf = Buffer.allocUnsafe(chunkSize);
    let pos = 0;
    while (pos < size) {
      const want = Math.min(chunkSize, size - pos);
      const read = fs.readSync(fdSrc, buf, 0, want, pos);
      if (read <= 0) break;
      fs.writeSync(fdDst, buf, 0, read);
      pos += read;
    }
  } finally {
    fs.closeSync(fdSrc);
    fs.closeSync(fdDst);
  }
}

/** 递归复制目录（所有文件走分块复制） */
function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name);
    const d = path.join(dst, e.name);
    if (e.isDirectory()) copyDir(s, d);
    else if (e.isFile()) copyFileChunked(s, d, 8 * 1024 * 1024);
  }
}

// ---------- 0. 前置检查 ----------
const electronExe = path.join(ELECTRON_DIST, 'electron.exe');
if (!fs.existsSync(electronExe)) {
  console.error('[pack] 找不到 Electron 运行时：' + electronExe);
  console.error('[pack] 请先执行：npm install（electron 二进制需安装成功）');
  process.exit(1);
}
if (!fs.existsSync(path.join(ROOT, 'src', 'main.js'))) {
  console.error('[pack] 找不到 src/main.js');
  process.exit(1);
}
log(`Electron 运行时：${ELECTRON_DIST}（${mb(dirSize(ELECTRON_DIST))}）`);

// ---------- 1. 清空并复制运行时 ----------
rmIfExists(OUT_DIR);
fs.mkdirSync(OUT_DIR, { recursive: true });
log('步骤 1/5：复制 Electron 运行时（约 259MB，请稍候）…');
copyDir(ELECTRON_DIST, OUT_DIR);

// ---------- 2. 清掉 Electron 自带的示例应用 ----------
const resDir = path.join(OUT_DIR, 'resources');
rmIfExists(path.join(resDir, 'default_app.asar'));
rmIfExists(path.join(resDir, 'app.asar'));
rmIfExists(path.join(resDir, 'app'));
log('步骤 2/5：移除 Electron 自带示例应用');

// ---------- 3. 复制自己的代码 ----------
fs.mkdirSync(APP_OUT, { recursive: true });
copyDir(path.join(ROOT, 'src'), path.join(APP_OUT, 'src'));
if (fs.existsSync(path.join(ROOT, 'assets'))) {
  copyDir(path.join(ROOT, 'assets'), path.join(APP_OUT, 'assets'));
}
// 运行时唯一依赖（纯 WASM，无需编译，直接拷目录即可）
const dep = path.join(ROOT, 'node_modules', 'node-sqlite3-wasm');
if (fs.existsSync(dep)) {
  copyDir(dep, path.join(APP_OUT, 'node_modules', 'node-sqlite3-wasm'));
} else {
  console.error('[pack] 缺少依赖 node-sqlite3-wasm，请先 npm install');
  process.exit(1);
}
log('步骤 3/5：复制应用代码与依赖');

// ---------- 4. 写运行时 package.json（精简，去掉 dev 相关内容）----------
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const runtimePkg = {
  name: pkg.name,
  version: pkg.version,
  description: pkg.description || '',
  main: pkg.main, // "src/main.js"
  author: pkg.author || '',
  dependencies: { 'node-sqlite3-wasm': pkg.dependencies['node-sqlite3-wasm'] },
};
fs.writeFileSync(
  path.join(APP_OUT, 'package.json'),
  JSON.stringify(runtimePkg, null, 2),
  'utf8'
);
log('步骤 4/5：生成运行时 package.json');

// ---------- 5. exe 改名 + 使用说明 ----------
const oldExe = path.join(OUT_DIR, 'electron.exe');
const newExe = path.join(OUT_DIR, `${APP_NAME}.exe`);
if (fs.existsSync(oldExe)) fs.renameSync(oldExe, newExe);

const usage = [
  `${APP_NAME} v${pkg.version}（Windows x64 · 绿色免安装）`,
  '',
  '【启动】',
  `  双击 ${APP_NAME}.exe 即可，无需安装。`,
  '',
  '【基本操作】',
  '  · 小组件默认悬浮在屏幕右上角，可拖动标题栏移动、右下角拉伸尺寸。',
  '  · 顶部按钮：‹ › 切换月份，今天，⚙ 打开设置，🖱 切换鼠标穿透，─ 隐藏，✕ 退出。',
  '  · 快捷键 Ctrl + Shift + C：显示 / 隐藏小组件。',
  '  · 右键托盘图标：显示隐藏、打开设置、穿透、置顶、退出。',
  '',
  '【设置（⚙）】',
  '  · 透明度、窗口宽高、开机自启、鼠标穿透、显示农历 / 待办、一周起始、三套主题。',
  '  · 左侧可批量管理日程与待办（增删改、标记完成、清理已完成）。',
  '',
  '【数据存储】',
  '  SQLite 数据库与配置保存在 %APPDATA%\\desktop-calendar\\',
  '  （calendar.db 数据、config.json 配置）。卸载 / 删除本目录不会丢失数据。',
  '',
  '【提醒】',
  '  带开始时间且未完成的日程，到点会弹系统通知；点击通知会跳到对应日期。',
  '',
  '注：本版本为离线绿色包（未做代码签名），Windows SmartScreen 可能提示"未知发布者"，',
  '    选择"仍要运行"即可。',
].join('\n');
fs.writeFileSync(path.join(OUT_DIR, '使用说明.txt'), usage, 'utf8');
log('步骤 5/5：重命名 exe 并写入使用说明');

// ---------- 汇总 ----------
console.log('');
log('打包完成！');
log(`产物目录：${OUT_DIR}`);
log(`可执行档：${newExe}`);
log(`总大小  ：${mb(dirSize(OUT_DIR))}`);
console.log('');
log('提示：整个目录可随意移动；如需分发，把目录压成 zip 发给别人即可。');
