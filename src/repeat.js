/**
 * repeat.js — 日程重复规则（纯函数，可独立单元测试）
 *
 * 规则值：
 *   'none'    不重复（默认）
 *   'daily'   每天
 *   'weekly'  每周（按 anchor 的星期几）
 *   'weekday' 每个工作日（周一~周五）
 *   'monthly' 每月（按 anchor 的"日"，月份天数不足则跳过，如 31 号在 2 月不出现）
 *   'yearly'  每年（按 anchor 的月+日，2-29 在非闰年不出现）
 *
 * anchor = 日程原始日期（schedules.date）；occurrence = 实际出现的某一天
 */
'use strict';

function pad2(n) { return String(n).padStart(2, '0'); }
function parseDate(s) {
  const [y, m, d] = String(s).split('-').map(Number);
  return { y, m, d };
}
function fmtDate(y, m, d) { return `${y}-${pad2(m)}-${pad2(d)}`; }
function daysInMonth(y, m) { return new Date(y, m, 0).getDate(); }
function dowOf(s) { const { y, m, d } = parseDate(s); return new Date(y, m - 1, d).getDay(); }
function ymd(s) { const { y, m, d } = parseDate(s); return y * 10000 + m * 100 + d; }

const WEEKDAY = new Set([1, 2, 3, 4, 5]); // 周一~周五

/**
 * 判断 target 这一天是否命中长期规则 rule（基于 anchor）
 */
function matchesRepeat(rule, anchorStr, targetStr) {
  if (!rule || rule === 'none') return anchorStr === targetStr;
  const t = ymd(targetStr);
  const a = ymd(anchorStr);
  if (t < a) return false; // 不允许出现在 anchor 之前的日期

  const A = parseDate(anchorStr);
  const T = parseDate(targetStr);

  switch (rule) {
    case 'daily':
      return true;
    case 'weekly':
      return dowOf(anchorStr) === dowOf(targetStr);
    case 'weekday':
      return WEEKDAY.has(new Date(T.y, T.m - 1, T.d).getDay());
    case 'monthly':
      return A.d === T.d && daysInMonth(T.y, T.m) >= A.d;
    case 'yearly':
      return A.m === T.m && A.d === T.d && daysInMonth(T.y, T.m) >= A.d;
    default:
      return false;
  }
}

/**
 * 展开某个月份内、命中 rule 的所有日期（返回 'YYYY-MM-DD' 数组）
 */
function expandMonth(rule, anchorStr, year, month) {
  if (!rule || rule === 'none') return [];
  const dim = daysInMonth(year, month);
  const res = [];
  for (let d = 1; d <= dim; d++) {
    const target = fmtDate(year, month, d);
    if (matchesRepeat(rule, anchorStr, target)) res.push(target);
  }
  return res;
}

const LABELS = {
  none: '不重复', daily: '每天', weekly: '每周',
  weekday: '每工作日', monthly: '每月', yearly: '每年',
};
function repeatLabel(rule) { return LABELS[rule] || LABELS.none; }

module.exports = { matchesRepeat, expandMonth, repeatLabel, parseDate, fmtDate, daysInMonth };
