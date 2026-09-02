/**
 * accelerator.test.js — 快捷键转换工具单元测试
 * 用 Node 内置 assert 跑，无外部依赖。
 * 运行：node scripts/accelerator.test.js
 */
'use strict';
const assert = require('assert');
const { DEFAULT_SHORTCUT, keydownToAccelerator, formatAccelerator } = require('../src/accelerator.js');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; }
  catch (e) { fail++; console.error('  ✗', name, '\n    ', e.message); }
}

// 构造一个模拟 KeyboardEvent 的最小子集
function ev(code, { ctrl = false, alt = false, shift = false, meta = false, key = '' } = {}) {
  return { code, key: key || code, ctrlKey: ctrl, altKey: alt, shiftKey: shift, metaKey: meta };
}

// ---------- 基本转换 ----------
t('Ctrl+Shift+C → CommandOrControl+Shift+C', () => {
  const r = keydownToAccelerator(ev('KeyC', { ctrl: true, shift: true }));
  assert.strictEqual(r.accelerator, 'CommandOrControl+Shift+C');
});
t('Ctrl+Alt+K', () => {
  const r = keydownToAccelerator(ev('KeyK', { ctrl: true, alt: true }));
  assert.strictEqual(r.accelerator, 'CommandOrControl+Alt+K');
});
t('单 F8 允许', () => {
  const r = keydownToAccelerator(ev('F8'));
  assert.strictEqual(r.accelerator, 'F8');
});
t('数字键 Ctrl+1', () => {
  const r = keydownToAccelerator(ev('Digit1', { ctrl: true }));
  assert.strictEqual(r.accelerator, 'CommandOrControl+1');
});
t('方向键 Alt+Up', () => {
  const r = keydownToAccelerator(ev('ArrowUp', { alt: true }));
  assert.strictEqual(r.accelerator, 'Alt+Up');
});
t('Super+Space', () => {
  const r = keydownToAccelerator(ev('Space', { meta: true }));
  assert.strictEqual(r.accelerator, 'Super+Space');
});

// ---------- 拒绝场景 ----------
t('只按 Ctrl（纯修饰键）→ 未完成，不报错', () => {
  const r = keydownToAccelerator(ev('ControlLeft', { ctrl: true }));
  assert.strictEqual(r.accelerator, null);
  assert.strictEqual(r.reason, null);
});
t('单字母 C 无修饰 → 拒绝（防误触）', () => {
  const r = keydownToAccelerator(ev('KeyC'));
  assert.strictEqual(r.accelerator, null);
  assert.ok(r.reason.includes('Ctrl/Alt/Shift'));
});
t('单数字 5 无修饰 → 拒绝', () => {
  const r = keydownToAccelerator(ev('Digit5'));
  assert.strictEqual(r.accelerator, null);
});
t('Escape → 取消', () => {
  const r = keydownToAccelerator(ev('Escape'));
  assert.strictEqual(r.accelerator, null);
  assert.strictEqual(r.reason, '已取消（Esc）');
});
t('未知键（如 oem 符号 Shift+~）→ 拒绝', () => {
  const r = keydownToAccelerator(ev('Backquote', { shift: true }));
  assert.strictEqual(r.accelerator, null);
});

// ---------- 展示格式化 ----------
t('formatAccelerator 中文友好：CommandOrControl+Shift+C → Ctrl+Shift+C', () => {
  assert.strictEqual(formatAccelerator('CommandOrControl+Shift+C'), 'Ctrl+Shift+C');
});
t('formatAccelerator 处理 Super → Win', () => {
  assert.strictEqual(formatAccelerator('Super+Space'), 'Win+Space');
});
t('formatAccelerator 保留 Shift/Alt/键名', () => {
  assert.strictEqual(formatAccelerator('CommandOrControl+Alt+K'), 'Ctrl+Alt+K');
});
t('formatAccelerator 空/无值 → 空串', () => {
  assert.strictEqual(formatAccelerator(''), '');
  assert.strictEqual(formatAccelerator(null), '');
});
t('默认快捷键是 Ctrl+Shift+C', () => {
  assert.strictEqual(DEFAULT_SHORTCUT, 'CommandOrControl+Shift+C');
});

console.log(`\naccelerator.test.js: ${pass} 通过, ${fail} 失败`);
if (fail > 0) process.exit(1);
