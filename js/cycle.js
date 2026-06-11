// 周期推算器。纯函数，无 IO，可单测。
//
// 核心原则：数据库只存"观察事实/亲口宣告"，"现在处于什么状态"由本函数对
// 全部历史重新推算 —— 新观察可以回溯修正旧解读，但旧记录本身永远不需要改。
//
// 事件词汇：
//   jelly        果冻状分泌物（排卵信号）
//   bleed_light  少量出血（纯观察）
//   bleed_heavy  经期血量出血（纯观察，不再等于"经期开始"）
//   period_start 亲口宣告经期开始（判定第一层；旧数据"来例假了"语义恰好兼容）
//   not_period   亲口否认"这不是月经"（把所在出血段钉死为孤立出血）
//   period_end   口头报告经期结束
//   pms_start    口头/确认进入 PMS
//
// 一段出血是否=月经，三层从硬到软：
//   1. 亲口宣告最大：段内有 period_start → 是月经（Day1 = 宣告日）；
//      有 not_period → 不是。冲突以日期较晚者为准，同日否认赢。
//   2/3. 无宣告：出血 ≥2 天且含 heavy → 判月经，Day1 = 段内第一天 heavy
//        （前置的少量点滴不算 Day1，但仍参与分段与顺延）。
//   两张安全网不自动下结论，返回 suspectBleed 让 UI 弹窗问主人：
//   - post_period：上次经期结束后 postPeriodSuspectDays 天内又出血 → 挂起自动判定。
//   - isolated_heavy：孤立单日 heavy 且不在预测经期窗口内（窗口内先等次日
//     续上自动成段；窗口划过仍孤立则补问）。

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
//   dayN,                 经期第几天（period 时，按判定后的 Day1 算）
//   pmsDayN,              PMS 第几天（pms 时，Day1 = 报告当天）
//   periodStart,          当前/最近一次经期的 Day1，无则 null
//   daysSinceEnd,         距最近一次经期结束的天数（经期中或无记录时 null）
//   ovulationDate,        排卵日 = 果冻段末+1（黏液消退日）；段进行中/已消费 null
//   ovulationPending,     果冻段进行中（最后一条 jelly = 今天），排卵日待定
//   daysSinceOvulation,   排卵后第几天（pending/经期已来过 null）
//   predictedPeriod,      预测经期窗口 { start, end } = 排卵日+lutealDays ~ +lutealMaxDays；
//                         窗口划过/pending/已消费 null
//   spottingToday,        今天落在"未判为经期的出血段"内
//   suspectBleed,         null | { date, reason: 'isolated_heavy'|'post_period' }，
//                         UI 据此弹"疑似不正出血"询问（答案落 period_start/not_period）
//   phase: 'period'|'ovulation'|'luteal'|'normal'
// }
export function deriveState(events, todayStr, cfg) {
  const {
    periodLength,
    pmsMaxDays = 14,
    bleedGapDays = 1,
    lutealDays = 14,
    lutealMaxDays = 21,
    postPeriodSuspectDays = 5,
  } = cfg;

  // ---- 排卵原始信息先算（安全网一要用预测窗口）----
  const jellies = dates(events, todayStr, 'jelly');
  const jellyRuns = runs(jellies, 0).filter((r) => r.length >= 2); // 严格逐日连续，单日不算
  const lastJellyRun = jellyRuns.length ? jellyRuns[jellyRuns.length - 1] : null;
  const jellyEnd = lastJellyRun ? lastJellyRun[lastJellyRun.length - 1] : null;
  const pending = jellyEnd === todayStr; // 黏液还没消退，排卵日定不下来
  const rawOvu = lastJellyRun && !pending ? addDays(jellyEnd, 1) : null; // 排卵日 = 段末+1
  const windowStart = rawOvu ? addDays(rawOvu, lutealDays) : null;
  const windowEnd = rawOvu ? addDays(rawOvu, lutealMaxDays) : null;

  // ---- 出血段逐段分类（按时间顺序；period_end 拆出的残段重新排队）----
  const heavySet = new Set(dates(events, todayStr, 'bleed_heavy'));
  const allBleeds = dates(events, todayStr, 'bleed_light', 'bleed_heavy', 'period_start');
  const starts = dates(events, todayStr, 'period_start');
  const nots = dates(events, todayStr, 'not_period');
  const ends = dates(events, todayStr, 'period_end');

  const queue = runs(allBleeds, bleedGapDays);
  const periods = []; // { day1, endDate }
  const spottingRuns = [];
  const suspects = []; // { date, reason }

  while (queue.length) {
    const seg = queue.shift();
    const segFirst = seg[0];
    const segLast = seg[seg.length - 1];
    const sIn = starts.filter((d) => d >= segFirst && d <= segLast);
    const nIn = nots.filter((d) => d >= segFirst && d <= segLast);
    let day1 = null;

    if (sIn.length || nIn.length) {
      // 第一层：宣告最大。Day1 = 最后一次否认之后最早的宣告（否认未被翻案则不是月经）
      const lastNot = nIn[nIn.length - 1] ?? null;
      const valid = lastNot ? sIn.filter((d) => d > lastNot) : sIn;
      day1 = valid[0] ?? null;
    } else {
      const prev = periods[periods.length - 1];
      if (prev && segFirst > prev.endDate && diffDays(prev.endDate, segFirst) <= postPeriodSuspectDays) {
        // 安全网二：刚结束经期没几天又出血 → 不自动下结论
        suspects.push({ date: seg.find((d) => heavySet.has(d)) ?? segFirst, reason: 'post_period' });
        spottingRuns.push(seg);
        continue;
      }
      const firstHeavy = seg.find((d) => heavySet.has(d)) ?? null;
      if (seg.length >= 2 && firstHeavy) {
        day1 = firstHeavy; // 第二/三层
      } else if (seg.length === 1 && firstHeavy) {
        // 安全网一：孤立单日 heavy。在预测窗口内且窗口未划过 → 先不问（等次日续上）
        const waitInWindow =
          windowStart && segFirst >= windowStart && segFirst <= windowEnd && todayStr <= windowEnd;
        if (!waitInWindow) suspects.push({ date: segFirst, reason: 'isolated_heavy' });
      }
    }

    if (!day1) {
      spottingRuns.push(seg);
      continue;
    }

    // 结束日：口头报告优先（之后的出血拆出去重新分类 → 自然落入安全网二）；
    // 否则默认时长兜底，段内持续报血则顺延
    const nextSeg = queue[0] ?? null;
    const eIn = ends.filter((d) => d >= day1 && (!nextSeg || d < nextSeg[0]));
    let endDate;
    if (eIn.length) {
      endDate = eIn[0];
      const residual = seg.filter((d) => d > endDate);
      if (residual.length) queue.unshift(residual);
    } else {
      const fallback = addDays(day1, periodLength - 1);
      endDate = segLast > fallback ? segLast : fallback;
    }
    periods.push({ day1, endDate });
  }

  // ---- 当前经期状态：看最后一段经期 ----
  let mode = 'daily';
  let dayN = null;
  let periodStart = null;
  let daysSinceEnd = null;
  const lastPeriod = periods[periods.length - 1] ?? null;
  if (lastPeriod) {
    periodStart = lastPeriod.day1;
    if (todayStr <= lastPeriod.endDate) {
      mode = 'period';
      dayN = diffDays(periodStart, todayStr) + 1;
    } else {
      daysSinceEnd = diffDays(lastPeriod.endDate, todayStr);
    }
  }

  const spottingToday = spottingRuns.some((r) => r.includes(todayStr));
  const suspectBleed = suspects[suspects.length - 1] ?? null;

  // ---- PMS：报告驱动，经期开始即终结，pmsMaxDays 兜底 ----
  let pmsDayN = null;
  if (mode !== 'period') {
    const pmsStarts = dates(events, todayStr, 'pms_start');
    if (pmsStarts.length) {
      const p = pmsStarts[pmsStarts.length - 1];
      const terminated = periodStart !== null && p <= periodStart;
      if (!terminated && diffDays(p, todayStr) < pmsMaxDays) {
        mode = 'pms';
        pmsDayN = diffDays(p, todayStr) + 1; // PMS Day 1 = 报告当天
      }
    }
  }

  // ---- 排卵展示字段："完成使命"：经期来了这次排卵的派生信息全部清空 ----
  const anchor = rawOvu ?? jellyEnd;
  const consumed = !!(lastJellyRun && periodStart && periodStart >= anchor);
  const ovulationPending = !!(lastJellyRun && pending && !consumed);
  let ovulationDate = null;
  let daysSinceOvulation = null;
  let predictedPeriod = null;
  if (lastJellyRun && !pending && !consumed) {
    ovulationDate = rawOvu;
    daysSinceOvulation = diffDays(rawOvu, todayStr);
    if (todayStr <= windowEnd) predictedPeriod = { start: windowStart, end: windowEnd };
  }

  // ---- 阶段（状态行展示）：经期 > 排卵期 > 黄体期 > 正常 ----
  // 排卵期 = 果冻段第 2 天起到排卵日（段末+1）当天；黄体期紧随其后无空窗，
  // 直到经期到来（距排卵日 lutealMaxDays 天兜底）。
  let phase = mode === 'period' ? 'period' : 'normal';
  if (mode !== 'period' && lastJellyRun && !consumed && todayStr >= lastJellyRun[1]) {
    if (pending || todayStr <= rawOvu) phase = 'ovulation';
    else if (diffDays(rawOvu, todayStr) <= lutealMaxDays) phase = 'luteal';
  }

  return {
    mode, dayN, pmsDayN, periodStart, daysSinceEnd,
    ovulationDate, ovulationPending, daysSinceOvulation, predictedPeriod,
    spottingToday, suspectBleed, phase,
  };
}

// "今天经期第N天" → 反推起始日期
export function backfillStart(todayStr, dayN) {
  return addDays(todayStr, -(dayN - 1));
}
