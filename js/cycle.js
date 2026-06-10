// 经期状态机（spec §4）。纯函数，无 IO，可单测。
// 状态由 cycle_event 事件表 + 日期推算，不依赖用户每天报告。

import { addDays, diffDays } from './dates.js';

// events: [{event:'period_start'|'period_end', date:'YYYY-MM-DD'}, ...]（顺序任意）
// 返回 { mode: 'daily'|'pms'|'period', dayN: number|null, nextPeriodDate: string|null }
export function deriveMode(events, todayStr, cfg) {
  const { cycleLength, pmsWindow, periodLength } = cfg;
  const starts = events
    .filter((e) => e.event === 'period_start' && e.date <= todayStr)
    .map((e) => e.date)
    .sort();
  if (starts.length === 0) return { mode: 'daily', dayN: null, nextPeriodDate: null };

  const lastStart = starts[starts.length - 1];
  const ends = events
    .filter((e) => e.event === 'period_end' && e.date >= lastStart)
    .map((e) => e.date)
    .sort();
  const end = ends.length > 0 ? ends[0] : null;
  const nextPeriodDate = addDays(lastStart, cycleLength);

  // 经期窗口：有显式 end 用 [start, end]，否则用默认 periodLength 兜底
  const inPeriod = end
    ? todayStr >= lastStart && todayStr <= end
    : todayStr >= lastStart && todayStr <= addDays(lastStart, periodLength - 1);
  if (inPeriod) {
    return { mode: 'period', dayN: diffDays(lastStart, todayStr) + 1, nextPeriodDate };
  }

  // PMS 窗口：[下次经期 - pmsWindow, 下次经期 - 1]
  if (todayStr >= addDays(nextPeriodDate, -pmsWindow) && todayStr <= addDays(nextPeriodDate, -1)) {
    return { mode: 'pms', dayN: null, nextPeriodDate };
  }
  return { mode: 'daily', dayN: null, nextPeriodDate };
}

// "今天经期第N天" → 反推 period_start 日期
export function backfillStart(todayStr, dayN) {
  return addDays(todayStr, -(dayN - 1));
}
