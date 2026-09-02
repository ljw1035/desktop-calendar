/**
 * css-hidden.test.js — 防止 "author display 压过 hidden 属性" 回归的静态检查
 *
 * 背景（2026-09-02 真机 bug）：`.modal-mask { display:flex }` 覆盖了浏览器
 * 对 hidden 属性的 UA 默认 display:none，导致弹窗遮罩从启动起永久显示、
 * 盖住整个窗口，页面所有交互失效。jsdom 冒烟测试不应用 CSS，抓不到。
 *
 * 检查两件事：
 *  1. 每个 HTML 用到 hidden 属性的页面，其配对 CSS 必须含
 *     `[hidden] { display: none !important; }` 全局规则（根治保障）。
 *  2. 报告 hidden 元素命中的、设置了非 none display 的类规则（信息性）。
 */
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'src');
let failures = 0;

for (const html of ['widget.html', 'settings.html']) {
  const htmlPath = path.join(SRC, html);
  const cssName = html.replace(/\.html$/, '.css');
  const cssPath = path.join(SRC, cssName);
  if (!fs.existsSync(htmlPath) || !fs.existsSync(cssPath)) continue;

  const htmlText = fs.readFileSync(htmlPath, 'utf8');
  const cssText = fs.readFileSync(cssPath, 'utf8');

  // --- 检查 1：必须存在 [hidden] 全局根治规则 ---
  const hasGlobalRule = /\[hidden\][^{]*\{[^}]*display:\s*none\s*!important/i.test(cssText.replace(/\s+/g, ' '));
  if (!hasGlobalRule) {
    failures++;
    console.log(`FAIL: ${cssName} 缺少 [hidden] { display: none !important; } 全局规则`);
  } else {
    console.log(`PASS: ${cssName} 含 [hidden] 全局规则`);
  }

  // --- 检查 2：列出 hidden 元素命中的 display 类规则（信息性） ---
  const hiddenTags = [...htmlText.matchAll(/<[^>]*\shidden[^>]*>/g)].map((m) => m[0]);
  const classesOfHidden = new Set();
  for (const tag of hiddenTags) {
    const cls = /class="([^"]*)"/.exec(tag);
    if (cls) cls[1].split(/\s+/).forEach((c) => c && classesOfHidden.add(c));
  }
  for (const c of classesOfHidden) {
    const re = new RegExp(`\\.${c}\\s*\\{[^}]*display:\\s*(?!none)([a-z-]+)`, 'i');
    const m = re.exec(cssText);
    if (m) console.log(`  信息: ${cssName} 的 .${c} 设了 display:${m[1]}（hidden 切换依赖全局规则兜底）`);
  }
}

if (failures) {
  console.log(`\n${failures} 项检查失败`);
  process.exit(1);
}
console.log('\ncss-hidden 检查全部通过 ✓');
