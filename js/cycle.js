// 周期推算器。纯函数，无 IO，可单测。
//
// 核心原则：数据库只存"观察事实"（果冻/少量出血/经期血量/口头边界），
// "现在处于什么状态"由本函数对全部历史重新推算 —— 新观察可以回溯修正旧解读，
// 但旧记录本身永远不需要改。
//
// 事件词汇：
//   jelly        果冻状分泌物（排卵信号）
//   bleed_light  少量出血
//   bleed_heavy  经期血量出血（"来例假了"也算这个）
//   period_start 旧版数据兼容，等价于 bleed_heavy
//   period_end   口头报告经期结束
//   pms_start    口头/确认进入 PMS

import { addDays, diffDays } from './dates.js';

const dates = (events, todayStr, ...types) =>
  [...new Set(
    events.filter((e) => types.includes(e.event) && e.date <= todayStr).map((e) => e.date)
  )].sort();

// 把日期列表按"相邻日期相差 ≤ maxGap+1 天"分段（maxGap=1：断档一天仍算同一段）
function runs(dateList, maxGap) {
  const out = [];
  for (const d of dateList) {
    const cur = out[out.length - 1];
    if (cur && diffDays(cur[cur.length - 1], d) <= maxGap + 1) cur.push(d);
    else out.push([d]);
  }
  return out;
}

// 返回 {
//   mode: 'daily'|'pms'|'period',
//   dayN,                 经期第几天（period 时，按回溯后的 Day1 算）
//   periodStart,          当前/最近一次经期的起始日（回溯后），无则 null
//   daysSinceEnd,         距最近一次经期结束的天数（经期中或无记录时 null）
//   ovulationDate,        最近一次排卵日（果冻连续段最后一天；段进行中则暂记今天）
//   daysSinceOvulation,   排卵后第几天（经期已来过则 null —— 计数完成使命）
//   spottingToday,        今天是否为孤立少量出血（不并入任何经期段）
// }
export function deriveState(events, todayStr, cfg) {
  const { periodLength, pmsMaxDays = 14, bleedGapDays = 1, lutealDays = 14 } = cfg;

  // ---- 出血段：light+heavy 合并分段，含 heavy 的段才是经期 ----
  const heavySet = new Set(dates(events, todayStr, 'bleed_heavy', 'period_start'));
  const allBleeds = dates(events, todayStr, 'bleed_light', 'bleed_heavy', 'period_start');
  const bleedRuns = runs(allBleeds, bleedGapDays);
  const periodRuns = bleedRuns.filter((r) => r.some((d) => heavySet.has(d)));
  const lastPeriodRun = periodRuns.length ? periodRuns[periodRuns.length - 1] : null;

  let mode = 'daily';
  let dayN = null;
  let periodStart = null;
  let daysSinceEnd = null;
  let lastPeriodEnd = null;

  if (lastPeriodRun) {
    periodStart = lastPeriodRun[0]; // 回溯：段内最早一天（哪怕当时记的是少量出血）
    const lastBleed = lastPeriodRun[lastPeriodRun.length - 1];
    const explicitEnds = dates(events, todayStr, 'period_end').filter((d) => d >= periodStart);
    const fallbackEnd = addDays(periodStart, periodLength - 1);
    // 没口头报结束时：默认时长兜底，但持续报血会顺延
    const endDate = explicitEnds.length
      ? explicitEnds[0]
      : lastBleed > fallbackEnd ? lastBleed : fallbackEnd;
    if (todayStr <= endDate) {
      mode = 'period';
      dayN = diffDays(periodStart, todayStr) + 1;
    } else {
      lastPeriodEnd = endDate;
      daysSinceEnd = diffDays(endDate, todayStr);
    }
  }

  // ---- 孤立少量出血（不正出血）----
  const spottingToday = bleedRuns.some(
    (r) => r.includes(todayStr) && !r.some((d) => heavySet.has(d))
  );

  // ---- PMS：报告驱动，经期开始即终结，pmsMaxDays 兜底 ----
  if (mode !== 'period') {
    const pmsStarts = dates(events, todayStr, 'pms_start');
    if (pmsStarts.length) {
      const p = pmsStarts[pmsStarts.length - 1];
      const terminated = periodStart !== null && p <= periodStart; // 已被这次经期终结
      if (!terminated && diffDays(p, todayStr) < pmsMaxDays) mode = 'pms';
    }
  }

  // ---- 排卵：果冻连续段（严格逐日连续）的最后一天 ----
  const jellies = dates(events, todayStr, 'jelly');
  const jellyRuns = jellies.length ? runs(jellies, 0) : [];
  let ovulationDate = null;
  let daysSinceOvulation = null;
  let predictedPeriod = null; // 排卵日 + 黄体期 ≈ 预测经期（周期不准时唯一可靠的预估）
  if (jellyRuns.length) {
    const lastRun = jellyRuns[jellyRuns.length - 1];
    ovulationDate = lastRun[lastRun.length - 1];
    // 经期已经来了 → 这次排卵计数完成使命，不再显示
    const consumed = periodStart && periodStart >= ovulationDate;
    if (!consumed) {
      daysSinceOvulation = diffDays(ovulationDate, todayStr);
      predictedPeriod = addDays(ovulationDate, lutealDays);
    }
  }

  // ---- 阶段（状态行展示）：经期 > 排卵期 > 黄体期 > 正常 ----
  // 排卵期 = 连续 ≥2 天果冻的段内；段一结束立刻进入黄体期，
  // 直到经期到来（上限 16 天兜底）。
  let phase = mode === 'period' ? 'period' : 'normal';
  if (mode !== 'period') {
    const runs2 = jellyRuns.filter((r) => r.length >= 2);
    if (runs2.length) {
      const r2 = runs2[runs2.length - 1];
      const end2 = r2[r2.length - 1];
      const consumed2 = periodStart && periodStart >= end2;
      if (!consumed2 && todayStr >= r2[0]) {
        const since = diffDays(end2, todayStr);
        if (since <= 0) phase = 'ovulation';
        else if (since <= 16) phase = 'luteal';
      }
    }
  }

  return {
    mode, dayN, periodStart, daysSinceEnd,
    ovulationDate, daysSinceOvulation, predictedPeriod, spottingToday, phase,
  };
}

// "今天经期第N天" → 反推起始日期
export function backfillStart(todayStr, dayN) {
  return addDays(todayStr, -(dayN - 1));
}
