/**
 * lunar.js — 简化版公历转农历（含节气、农历节日、公历节日）
 * 数据范围 1900-2099
 * 精度说明：节气为近似日期（每年可能 ±1 天），对个人日历工具足够。
 *
 * 用法：Lunar.getInfo(2026, 9, 1) → { lunarText, solarFestival, lunarFestival, solarTerm, primary }
 */
(function () {
  'use strict';

  // 农历年信息表（每年 16 进制编码）
  // bit 4-15: 12位表示每个月的大小月（1=大 30天，0=小 29天）
  // bit 0-3 : 闰月月份（0=无闰月）
  // bit 16  : 闰月天数（0=29天，1=30天）
  const lunarInfo = [
    0x04bd8,0x04ae0,0x0a570,0x054d5,0x0d260,0x0d950,0x16554,0x056a0,0x09ad0,0x055d2, // 1900-1909
    0x04ae0,0x0a5b6,0x0a4d0,0x0d250,0x1d255,0x0b540,0x0d6a0,0x0ada2,0x095b0,0x14977, // 1910-1919
    0x04970,0x0a4b0,0x0b4b5,0x06a50,0x06d40,0x1ab54,0x02b60,0x09570,0x052f2,0x04970, // 1920-1929
    0x06566,0x0d4a0,0x0ea50,0x06e95,0x05ad0,0x02b60,0x186e3,0x092e0,0x1c8d7,0x0c950, // 1930-1939
    0x0d4a0,0x1d8a6,0x0b550,0x056a0,0x1a5b4,0x025d0,0x092d0,0x0d2b2,0x0a950,0x0b557, // 1940-1949
    0x06ca0,0x0b550,0x15355,0x04da0,0x0a5b0,0x14573,0x052b0,0x0a9a8,0x0e950,0x06aa0, // 1950-1959
    0x0aea6,0x0ab50,0x04b60,0x0aae4,0x0a570,0x05260,0x0f263,0x0d950,0x05b57,0x056a0, // 1960-1969
    0x096d0,0x04dd5,0x04ad0,0x0a4d0,0x0d4d4,0x0d250,0x0d558,0x0b540,0x0b6a0,0x195a6, // 1970-1979
    0x095b0,0x049b0,0x0a974,0x0a4b0,0x0b27a,0x06a50,0x06d40,0x0af46,0x0ab60,0x09570, // 1980-1989
    0x04af5,0x04970,0x064b0,0x074a3,0x0ea50,0x06b58,0x055c0,0x0ab60,0x096d5,0x092e0, // 1990-1999
    0x0c960,0x0d954,0x0d4a0,0x0da50,0x07552,0x056a0,0x0abb7,0x025d0,0x092d0,0x0cab5, // 2000-2009
    0x0a950,0x0b4a0,0x0baa4,0x0ad50,0x055d9,0x04ba0,0x0a5b0,0x15176,0x052b0,0x0a930, // 2010-2019
    0x07954,0x06aa0,0x0ad50,0x05b52,0x04b60,0x0a6e6,0x0a4e0,0x0d260,0x0ea65,0x0d530, // 2020-2029
    0x05aa0,0x076a3,0x096d0,0x04afb,0x04ad0,0x0a4d0,0x1d0b6,0x0d250,0x0d520,0x0dd45, // 2030-2039
    0x0b5a0,0x056d0,0x055b2,0x049b0,0x0a577,0x0a4b0,0x0aa50,0x1b255,0x06d20,0x0ada0, // 2040-2049
    0x14b63,0x09370,0x049f8,0x04970,0x064b0,0x168a6,0x0ea50,0x06b20,0x1a6c4,0x0aae0, // 2050-2059
    0x0a2e0,0x0d2e3,0x0c960,0x0d557,0x0d4a0,0x0da50,0x05d55,0x056a0,0x0a6d0,0x055d4, // 2060-2069
    0x052d0,0x0a9b8,0x0a950,0x0b4a0,0x0b6a6,0x0ad50,0x055a0,0x0aba4,0x0a5b0,0x052b0, // 2070-2079
    0x0b273,0x06930,0x07337,0x06aa0,0x0ad50,0x14b55,0x04b60,0x0a570,0x054e4,0x0d160, // 2080-2089
    0x0e968,0x0d520,0x0daa0,0x16aa6,0x056d0,0x04ae0,0x0a9d4,0x0a2d0,0x0d150,0x0f252, // 2090-2099
    0x0d520 // 2099（占位）
  ];

  function leapMonth(y)        { return lunarInfo[y - 1900] & 0xf; }
  function leapDays(y)         { return leapMonth(y) ? ((lunarInfo[y - 1900] & 0x10000) ? 30 : 29) : 0; }
  function monthDays(y, m)     { return (lunarInfo[y - 1900] & (0x10000 >> m)) ? 30 : 29; }
  function yearDays(y) {
    let sum = 348;
    for (let i = 0x8000; i > 0x8; i >>= 1) sum += (lunarInfo[y - 1900] & i) ? 1 : 0;
    return sum + leapDays(y);
  }

  // 公历转农历
  function toLunar(year, month, day) {
    if (year < 1900 || year > 2099) return null;
    const base = new Date(1900, 0, 31);
    const target = new Date(year, month - 1, day);
    let offset = Math.floor((target - base) / 86400000);
    if (offset < 0) return null;

    let y = 1900, temp = 0;
    while (y < 2100 && offset > 0) {
      temp = yearDays(y);
      if (offset < temp) break;
      offset -= temp;
      y++;
    }
    if (offset === temp) { y++; offset = 0; }

    const lunarYear = y;
    const leap = leapMonth(y);   // 0 表示当年无闰月
    let isLeap = false;
    let m = 1;

    // 依次走过正月…十二月；若当年有闰月，则在第 leap 月之后插入一个"闰副本"。
    // 关键点：闰月期间月份号必须保持为 leap（不能 +1），
    // 否则闰月会被标成下一个月，其后的所有月份名都会整体偏移一个月。
    while (m <= 12) {
      const len = monthDays(y, m);
      if (offset < len) break;            // 落在本月内
      offset -= len;

      if (m === leap) {                   // 本月之后紧跟一个闰月
        const leapLen = leapDays(y);
        if (offset < leapLen) {           // 落在闰月内：月份号仍是 m，只打闰标记
          isLeap = true;
          break;
        }
        offset -= leapLen;
      }
      m++;
    }

    return { year: lunarYear, month: m, day: offset + 1, isLeapMonth: isLeap };
  }

  // 节气近似日期表（月份, 日期）
  const solarTerms = [
    [1, 6], [1, 20],       // 小寒 大寒
    [2, 4], [2, 19],       // 立春 雨水
    [3, 6], [3, 21],       // 惊蛰 春分
    [4, 5], [4, 20],       // 清明 谷雨
    [5, 6], [5, 21],       // 立夏 小满
    [6, 6], [6, 21],       // 芒种 夏至
    [7, 7], [7, 22],       // 小暑 大暑
    [8, 7], [8, 23],       // 立秋 处暑
    [9, 8], [9, 23],       // 白露 秋分
    [10, 8], [10, 23],     // 寒露 霜降
    [11, 7], [11, 22],     // 立冬 小雪
    [12, 7], [12, 22],     // 大雪 冬至
  ];
  const solarTermNames = ['小寒','大寒','立春','雨水','惊蛰','春分','清明','谷雨',
                          '立夏','小满','芒种','夏至','小暑','大暑','立秋','处暑',
                          '白露','秋分','寒露','霜降','立冬','小雪','大雪','冬至'];

  function getSolarTerm(month, day) {
    const idx = (month - 1) * 2;
    if (solarTerms[idx][0] === month && solarTerms[idx][1] === day) return solarTermNames[idx];
    if (solarTerms[idx + 1] && solarTerms[idx + 1][0] === month && solarTerms[idx + 1][1] === day) return solarTermNames[idx + 1];
    return '';
  }

  // 公历节日
  const solarFestivals = {
    '1-1': '元旦', '2-14': '情人节', '3-8': '妇女节', '3-12': '植树节',
    '4-1': '愚人节', '5-1': '劳动节', '5-4': '青年节', '6-1': '儿童节',
    '7-1': '建党节', '8-1': '建军节', '9-10': '教师节', '10-1': '国庆节',
    '11-1': '万圣节', '12-24': '平安夜', '12-25': '圣诞节',
  };

  // 农历节日（不含除夕等需要末日计算的）
  const lunarFestivals = {
    '1-1': '春节', '1-15': '元宵', '2-2': '龙抬头', '5-5': '端午',
    '7-7': '七夕', '7-15': '中元', '8-15': '中秋', '9-9': '重阳',
    '12-8': '腊八', '12-23': '小年',
  };

  const monthCn = ['正','二','三','四','五','六','七','八','九','十','冬','腊'];
  const dayChars = ['一','二','三','四','五','六','七','八','九','十'];

  function lunarDayName(d) {
    if (d === 10) return '初十';
    if (d === 20) return '二十';
    if (d === 30) return '三十';
    if (d < 10)   return '初' + dayChars[d - 1];
    if (d < 20)   return '十' + dayChars[d - 10 - 1];
    return '廿' + dayChars[d - 20 - 1];
  }

  /**
   * 获取某公历日的完整农历信息
   * @returns {{
   *   lunarText: string,        // 例如 "七月十五"
   *   solarText: string,        // 例如 "中秋"
   *   solarTerm: string,        // 例如 "立秋"
   *   primary: { text: string, type: 'holiday'|'solar'|'normal' }
   * }}
   */
  function getInfo(year, month, day) {
    const empty = {
      lunarText: '', solarText: '', solarTerm: '',
      primary: { text: '', type: 'normal' },
    };
    const lunar = toLunar(year, month, day);
    if (!lunar) return empty;

    const lm = (lunar.isLeapMonth ? '闰' : '') + monthCn[lunar.month - 1] + '月';
    const ld = lunarDayName(lunar.day);
    const lunarText = lm + ld;

    const term = getSolarTerm(month, day);
    const sf = solarFestivals[`${month}-${day}`] || '';
    // 闰月不重复过农历节日（如闰八月十五不应再报一次中秋）
    const lf = (!lunar.isLeapMonth && lunarFestivals[`${lunar.month}-${lunar.day}`]) || '';

    let primary;
    if (lf)         primary = { text: lf, type: 'holiday' };
    else if (sf)    primary = { text: sf, type: 'holiday' };
    else if (term)  primary = { text: term, type: 'solar' };
    else            primary = { text: lunarText, type: 'normal' };

    return {
      lunarText,
      solarText: lf || sf || '',
      solarTerm: term,
      primary,
    };
  }

  window.Lunar = { getInfo, toLunar };
})();