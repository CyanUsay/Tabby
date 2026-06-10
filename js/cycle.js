// 经期状态机。纯函数，无 IO，可单测。
// 设计前提：用户周期不规律，预测不可靠 —— 所以 PMS 不靠预测窗口推导，
// 完全由用户报告（pms_start 事件）触发，经期开始时自然结束（另有 pmsMaxDays 兜底）。

import { addDays, diffDays } from './dates.js';

// events: [{event, date}]，event ∈ period_start/period_end/pms_start/spotting/ovulation_sign
// 返回 {
//   mode: 'daily'|'pms'|'period',
//   dayN: 经期第几天（period 时）,
//   daysSinceEnd: 距最近一次经期结束的天数（经期中或无记录时 null）,
//   ovulating: 近 3 天内有排卵信号,
// }
export function deriveMode(events, todayStr, cfg) {
  const { periodLength, pmsMaxDays = 14 } = cfg;
  const latest = (type) => {
    const dates = events
      .filter((e) => e.event === type && e.date <= todayStr)
      .map((e) => e.date)
      .sort();
    return dates.length ? dates[dates.length - 1] : null;
  };

  const lastStart = latest('period_start');
  const lastSign = latest('ovulation_sign');
  const ovulating = lastSign !== null && diffDays(lastSign, todayStr) <= 2;

  if (!lastStart) {
    return { mode: pmsActive(events, todayStr, null, pmsMaxDays) ? 'pms' : 'daily', dayN: null, daysSinceEnd: null, ovulating };
  }

  // 经期窗口：有显式 end 用 [start, end]，否则用默认 periodLength 兜底
  const ends = events
    .filter((e) => e.event === 'period_end' && e.date >= lastStart)
    .map((e) => e.date)
    .sort();
  const explicitEnd = ends.length ? ends[0] : null;
  const endDate = explicitEnd ?? addDays(lastStart, periodLength - 1);

  if (todayStr <= endDate) {
    return { mode: 'period', dayN: diffDays(lastStart, todayStr) + 1, daysSinceEnd: null, ovulating };
  }

  const daysSinceEnd = diffDays(endDate, todayStr);
  const mode = pmsActive(events, todayStr, lastStart, pmsMaxDays) ? 'pms' : 'daily';
  return { mode, dayN: null, daysSinceEnd, ovulating };
}

// PMS：最近一次 pms_start 在最近经期开始之后（还没被新经期终结），
// 且距今不超过 pmsMaxDays（防止忘记报经期导致永久 PMS）。
function pmsActive(events, todayStr, lastPeriodStart, pmsMaxDays) {
  const starts = events
    .filter((e) => e.event === 'pms_start' && e.date <= todayStr)
    .map((e) => e.date)
    .sort();
  if (!starts.length) return false;
  const p = starts[starts.length - 1];
  if (lastPeriodStart && p <= lastPeriodStart) return false; // 已被这次经期终结
  return diffDays(p, todayStr) < pmsMaxDays;
}

// "今天经期第N天" → 反推 period_start 日期
export function backfillStart(todayStr, dayN) {
  return addDays(todayStr, -(dayN - 1));
}
