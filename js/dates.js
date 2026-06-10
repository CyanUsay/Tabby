// 日期工具：全站唯一的"今天"来源。
// 一律本地时区手拼 YYYY-MM-DD，绝不用 toISOString()（那是 UTC，会跨日错位）。

import { DAY_CUTOFF_HOUR } from './config.js';

export function fmt(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// app 意义上的"今天"：凌晨 0 点～DAY_CUTOFF_HOUR 之间算前一天
export function appToday(now = new Date(), cutoffHour = DAY_CUTOFF_HOUR) {
  const d = new Date(now);
  if (d.getHours() < cutoffHour) d.setDate(d.getDate() - 1);
  return fmt(d);
}

export function parseDate(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(y, m - 1, d); // 本地时区午夜，避免 Date('YYYY-MM-DD') 的 UTC 解析
}

export function addDays(dateStr, n) {
  const d = parseDate(dateStr);
  d.setDate(d.getDate() + n);
  return fmt(d);
}

// b - a 的天数（同日为 0）
export function diffDays(a, b) {
  return Math.round((parseDate(b) - parseDate(a)) / 86400000);
}

// 本周（周一为首日）的 7 个日期字符串，用于顶部周历条
export function weekOf(dateStr) {
  const d = parseDate(dateStr);
  const dow = (d.getDay() + 6) % 7; // 周一=0
  const monday = addDays(dateStr, -dow);
  return Array.from({ length: 7 }, (_, i) => addDays(monday, i));
}
