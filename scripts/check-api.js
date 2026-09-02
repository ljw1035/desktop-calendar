/**
 * scripts/check-api.js — 渲染层契约静态校验
 *
 * 为什么需要它：沙箱环境没有 GUI，渲染进程（widget.js / settings.js）根本跑不起来，
 * 所以"window.api.xxx 拼错 / preload 少暴露一个方法 / HTML 上 onclick 的函数没定义"
 * 这类错误只能等用户在真机上双击才暴露。这里用静态方式提前拦住：
 *
 *   1. 渲染层引用的每个 window.api.* 是否都在 preload 里真实存在
 *   2. HTML 里 onclick/onchange 等内联绑定的函数，是否在对应 JS 里有定义
 *   3. preload 暴露了但渲染层从没用过的方法（提示性，不算错）
 *
 * 用法：npm run check
 */
'use strict';
const fs = require('fs');
const path = require('path');
const Module = require('module');

const SRC = path.join(__dirname, '..', 'src');

// ---------- 1. mock electron，拿到 preload 真实暴露的 api 对象 ----------
let api = null;
const origLoad = Module._load;
Module._load = function (request) {
  if (request === 'electron') {
    return {
      contextBridge: { exposeInMainWorld: (k, v) => { api = v; } },
      ipcRenderer: { invoke: () => {}, on: () => {}, removeListener: () => {} },
    };
  }
  return origLoad.apply(this, arguments);
};
require(path.join(SRC, 'preload.js'));
Module._load = origLoad;

// ---------- 2. 把 api 拍平成 "a.b.c" -> 值 ----------
const flat = new Map();
(function walk(obj, prefix) {
  for (const [k, v] of Object.entries(obj)) {
    const p = prefix ? `${prefix}.${k}` : k;
    flat.set(p, v);
    if (v && typeof v === 'object') walk(v, p);
  }
})(api, '');

let failed = 0;

// ---------- 3. 校验渲染层 window.api.* 引用 ----------
console.log('[check-api] ① 渲染层 window.api.* 引用校验');
const usedPaths = new Set();
for (const f of ['widget.js', 'settings.js']) {
  const code = fs.readFileSync(path.join(SRC, f), 'utf8');
  const re = /window\.api\.([A-Za-z0-9_$]+(?:\.[A-Za-z0-9_$]+)*)/g;
  let m;
  while ((m = re.exec(code))) usedPaths.add(m[1]);
}

const sortedUsed = [...usedPaths].sort();
for (const p of sortedUsed) {
  const val = flat.get(p);
  const ok = typeof val === 'function';
  if (!ok) failed++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  window.api.${p}`);
}

// 反向：暴露了但没用到（提示）
const unused = [...flat.keys()].filter(
  (k) => typeof flat.get(k) === 'function' && !usedPaths.has(k)
);
if (unused.length) {
  console.log('  （提示）preload 暴露但渲染层未使用：' + unused.join(', '));
}
console.log('');

// ---------- 4. 校验 HTML 内联事件绑定的函数是否存在 ----------
console.log('[check-api] ② HTML 内联事件绑定校验');
for (const [htmlFile, jsFile] of [
  ['widget.html', 'widget.js'],
  ['settings.html', 'settings.js'],
]) {
  const htmlPath = path.join(SRC, htmlFile);
  if (!fs.existsSync(htmlPath)) continue;
  const html = fs.readFileSync(htmlPath, 'utf8');
  const js = fs.readFileSync(path.join(SRC, jsFile), 'utf8');

  const names = new Set();
  const re = /on(?:click|change|input|submit|keydown|keyup)\s*=\s*"\s*([A-Za-z_$][\w$]*)\s*\(/g;
  let m;
  while ((m = re.exec(html))) names.add(m[1]);

  if (names.size === 0) {
    console.log(`  --  ${htmlFile}：无内联绑定`);
    continue;
  }

  for (const name of [...names].sort()) {
    // 在 js 里找 function 声明 / const|let|var 赋值 / 对象方法简写
    const defined =
      new RegExp(`function\\s+${name}\\s*\\(`).test(js) ||
      new RegExp(`(?:const|let|var)\\s+${name}\\s*=`).test(js) ||
      new RegExp(`^\\s*${name}\\s*\\(`, 'm').test(js) ||
      new RegExp(`${name}\\s*:\\s*(?:async\\s*)?(?:function|\\()`).test(js);
    if (!defined) failed++;
    console.log(`  ${defined ? 'PASS' : 'FAIL'}  ${htmlFile} → ${name}()  (应在 ${jsFile} 定义)`);
  }
}
console.log('');

// ---------- 5. 校验 JS 引用的 DOM id 是否都在 HTML 里 ----------
// 事件如果靠 addEventListener 绑定，getElementById 拿到 null 时不会报错，
// 只会让按钮"点了没反应"——这是最难查的一类静默失效。
console.log('[check-api] ③ DOM id 引用校验（防止按钮点了没反应）');
for (const [htmlFile, jsFile] of [
  ['widget.html', 'widget.js'],
  ['settings.html', 'settings.js'],
]) {
  const htmlPath = path.join(SRC, htmlFile);
  if (!fs.existsSync(htmlPath)) continue;
  const html = fs.readFileSync(htmlPath, 'utf8');
  const js = fs.readFileSync(path.join(SRC, jsFile), 'utf8');

  const htmlIds = new Set();
  let m2;
  const idRe = /\sid\s*=\s*"([^"]+)"/g;
  while ((m2 = idRe.exec(html))) htmlIds.add(m2[1]);

  const refIds = new Set();
  const refRe = /getElementById\(\s*['"]([^'"]+)['"]\s*\)/g;
  while ((m2 = refRe.exec(js))) refIds.add(m2[1]);
  const qRe = /querySelector(?:All)?\(\s*['"]#([A-Za-z0-9_-]+)['"]/g;
  while ((m2 = qRe.exec(js))) refIds.add(m2[1]);

  const missing = [...refIds].filter((id) => !htmlIds.has(id));
  if (missing.length) {
    failed += missing.length;
    console.log(`  FAIL  ${jsFile} 引用了 ${missing.length} 个 HTML 里不存在的 id：${missing.join(', ')}`);
  } else {
    console.log(`  PASS  ${jsFile} 引用的 ${refIds.size} 个 id 全部存在于 ${htmlFile}`);
  }
}
console.log('');

// ---------- 汇总 ----------
if (failed > 0) {
  console.error(`[check-api] 发现 ${failed} 处问题，请修复后再打包！`);
  process.exit(1);
}
console.log('[check-api] 全部通过 ✓');
