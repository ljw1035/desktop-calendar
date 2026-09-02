/**
 * scripts/repeat.test.js — repeat.js 重复规则的单元测试（纯 Node，零依赖）
 *
 * 覆盖：6 种规则的命中/不命中边界 + expandMonth 展开 + 标签
 * 用法：npm test（会同时跑本文件与 smoke-renderer.js）
 */
'use strict';
const { matchesRepeat, expandMonth, repeatLabel, daysInMonth } = require('../src/repeat.js');

const cases = [];
const assert = (name, cond) => cases.push([name, cond]);

// ---------- matchesRepeat ----------
assert('none 锚点当天命中', matchesRepeat('none', '2026-09-02', '2026-09-02'));
assert('none 其他天不命中', !matchesRepeat('none', '2026-09-02', '2026-09-03'));
assert('null/undefined 等同 none', matchesRepeat(null, '2026-09-02', '2026-09-02'));

assert('daily 跨月命中', matchesRepeat('daily', '2026-09-02', '2026-10-15'));
assert('daily 锚点当天命中', matchesRepeat('daily', '2026-09-02', '2026-09-02'));
assert('daily 锚点前不命中', !matchesRepeat('daily', '2026-09-02', '2026-09-01'));

// 2026-09-02 是周三
assert('weekly 同星期命中', matchesRepeat('weekly', '2026-09-02', '2026-09-09'));
assert('weekly 不同星期不命中', !matchesRepeat('weekly', '2026-09-02', '2026-09-10'));
assert('weekly 锚点当天命中', matchesRepeat('weekly', '2026-09-02', '2026-09-02'));

// 2026-09-05 是周六，2026-09-07 是周一
assert('weekday 周中命中', matchesRepeat('weekday', '2026-09-05', '2026-09-07'));
assert('weekday 周六不命中', !matchesRepeat('weekday', '2026-09-05', '2026-09-06'));
assert('weekday 周日不命中', !matchesRepeat('weekday', '2026-09-05', '2026-09-13'));

assert('monthly 同日号命中', matchesRepeat('monthly', '2026-01-15', '2026-03-15'));
assert('monthly 日号不符不命中', !matchesRepeat('monthly', '2026-01-15', '2026-03-20'));
assert('monthly 31号 大月命中', matchesRepeat('monthly', '2026-01-31', '2026-03-31'));
assert('monthly 31号 2月不出现', !matchesRepeat('monthly', '2026-01-31', '2026-02-28'));
assert('monthly 31号 4月(30天)不出现', !matchesRepeat('monthly', '2026-01-31', '2026-04-30'));

assert('yearly 同月日命中', matchesRepeat('yearly', '2024-05-01', '2026-05-01'));
assert('yearly 月日不符不命中', !matchesRepeat('yearly', '2024-05-01', '2026-05-02'));
assert('yearly 2-29 闰年命中', matchesRepeat('yearly', '2024-02-29', '2028-02-29'));
assert('yearly 2-29 平年不出现', !matchesRepeat('yearly', '2024-02-29', '2026-02-28'));

assert('未知规则一律不命中', !matchesRepeat('bogus', '2026-09-02', '2026-09-09'));

// ---------- expandMonth ----------
// 2026 年 9 月的周三：2、9、16、23、30（锚点 9-2，共 5 个）
const e1 = expandMonth('weekly', '2026-09-02', 2026, 9);
assert('expand weekly 锚点当月=全部周三(5个)',
  e1.length === 5 && e1[0] === '2026-09-02' && e1[4] === '2026-09-30');

// 锚点在月中，月内周三从锚点起算：2026-09-16(周三) 起 → 16、23、30
const e2 = expandMonth('weekly', '2026-09-16', 2026, 9);
assert('expand weekly 锚点在月中', e2.length === 3 && e2[0] === '2026-09-16');

assert('expand none 返回空', expandMonth('none', '2026-09-02', 2026, 9).length === 0);
assert('expand monthly 2月(无31日)为空', expandMonth('monthly', '2026-01-31', 2026, 2).length === 0);

// 锚点 9-30，10 月每天命中 → 31 天
const e3 = expandMonth('daily', '2026-09-30', 2026, 10);
assert('expand daily 跨月=全月31天', e3.length === 31 && e3[0] === '2026-10-01' && e3[30] === '2026-10-31');

// 2026 年 10 月工作日：10-1(四)~10-31(六)，共 22 个工作日
const e4 = expandMonth('weekday', '2026-10-01', 2026, 10);
assert('expand weekday 2026-10 有 22 个工作日', e4.length === 22 && e4[0] === '2026-10-01');

// ---------- repeatLabel ----------
assert('label weekly', repeatLabel('weekly') === '每周');
assert('label 未知回退不重复', repeatLabel('bogus') === '不重复');

// ---------- daysInMonth ----------
assert('闰年2月29天', daysInMonth(2024, 2) === 29);
assert('平年2月28天', daysInMonth(2026, 2) === 28);

// ---------- 汇总 ----------
let fail = 0;
for (const [name, ok] of cases) {
  if (!ok) { fail++; console.log('FAIL: ' + name); }
}
console.log(fail === 0
  ? `repeat.js 单元测试全部通过 ✓（共 ${cases.length} 个断言）`
  : `${fail}/${cases.length} 个断言失败 ✗`);
process.exit(fail === 0 ? 0 : 1);
