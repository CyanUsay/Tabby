// 纯函数测试：node test/run-tests.mjs
// 只测 dates/protocol/cycle/白名单过滤，绝不接触网络或数据库。

import assert from 'node:assert/strict';
import { appToday, addDays, diffDays, weekOf } from '../js/dates.js';
import { getChecklist, SLOTS } from '../js/protocol.js';
import { deriveState, backfillStart } from '../js/cycle.js';
import {
  filterIntakeToChecklist,
  sanitizeRemove,
  removeRequiresIntent,
  dropContradictoryCycles,
  dropExistingCycles,
} from '../js/ai.js';

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`  ok - ${name}`);
}

const cfg = {
  periodLength: 5,
  pmsMaxDays: 14,
  bleedGapDays: 1,
  lutealDays: 14,
  lutealMaxDays: 21,
  postPeriodSuspectDays: 5,
};

console.log('dates.js');
test('凌晨 2 点算前一天', () => {
  assert.equal(appToday(new Date(2026, 5, 10, 2, 30)), '2026-06-09');
});
test('凌晨 4:59 仍算前一天', () => {
  assert.equal(appToday(new Date(2026, 5, 10, 4, 59)), '2026-06-09');
});
test('早上 5:00 起算当天', () => {
  assert.equal(appToday(new Date(2026, 5, 10, 5, 0)), '2026-06-10');
});
test('晚上 23 点算当天', () => {
  assert.equal(appToday(new Date(2026, 5, 10, 23, 0)), '2026-06-10');
});
test('addDays 跨月', () => {
  assert.equal(addDays('2026-05-30', 3), '2026-06-02');
  assert.equal(addDays('2026-06-01', -1), '2026-05-31');
});
test('diffDays', () => {
  assert.equal(diffDays('2026-06-01', '2026-06-10'), 9);
  assert.equal(diffDays('2026-06-10', '2026-06-10'), 0);
});
test('weekOf 周一为首日', () => {
  // 2026-06-10 是周三
  const w = weekOf('2026-06-10');
  assert.equal(w[0], '2026-06-08');
  assert.equal(w[6], '2026-06-14');
  assert.equal(w.length, 7);
});

console.log('protocol.js');
test('daily 清单 9 条，无 B6', () => {
  const list = getChecklist('daily');
  assert.equal(list.length, 9);
  assert.ok(!list.some((i) => i.supplement === 'B6'));
  assert.equal(list.find((i) => i.supplement === '甘氨酸镁').dose, '200 mg');
});
test('pms 加 B6、镁覆盖为 300mg', () => {
  const list = getChecklist('pms');
  assert.equal(list.length, 10);
  assert.ok(list.some((i) => i.supplement === 'B6' && i.slot === 'lunch'));
  assert.equal(list.find((i) => i.supplement === '甘氨酸镁').dose, '300 mg');
});
test('period 鱼油共 3 颗、镁 300mg、无额外 B6', () => {
  const list = getChecklist('period');
  assert.equal(list.length, 9);
  assert.equal(list.find((i) => i.supplement === '鱼油' && i.slot === 'lunch').dose, '2 颗');
  assert.equal(list.find((i) => i.supplement === '鱼油' && i.slot === 'dinner').dose, '1 颗');
  assert.equal(list.find((i) => i.supplement === '甘氨酸镁').dose, '300 mg');
  assert.ok(!list.some((i) => i.supplement === 'B6'));
});
test('清单按 slot 顺序排列', () => {
  const order = getChecklist('pms').map((i) => SLOTS.indexOf(i.slot));
  assert.deepEqual(order, [...order].sort((a, b) => a - b));
});

console.log('cycle.js（三层判经期）');
test('无事件 → daily', () => {
  const r = deriveState([], '2026-06-10', cfg);
  assert.equal(r.mode, 'daily');
  assert.equal(r.daysSinceEnd, null);
  assert.equal(r.daysSinceOvulation, null);
  assert.equal(r.suspectBleed, null);
});
test('第一层：亲口宣告当天即经期 Day 1', () => {
  const r = deriveState([{ event: 'period_start', date: '2026-06-08' }], '2026-06-08', cfg);
  assert.equal(r.mode, 'period');
  assert.equal(r.dayN, 1);
});
test('第二层：出血 ≥2 天且含 heavy → 自动判经期，Day1 = 第一天 heavy', () => {
  const events = [
    { event: 'bleed_light', date: '2026-06-07' },
    { event: 'bleed_heavy', date: '2026-06-08' },
    { event: 'bleed_heavy', date: '2026-06-09' },
  ];
  const r = deriveState(events, '2026-06-09', cfg);
  assert.equal(r.mode, 'period');
  assert.equal(r.periodStart, '2026-06-08'); // 前置 light 点滴不算 Day1
  assert.equal(r.dayN, 2);
});
test('安全网一：孤立单日 heavy 不自动开经期 → 疑似询问', () => {
  const r = deriveState([{ event: 'bleed_heavy', date: '2026-06-08' }], '2026-06-10', cfg);
  assert.equal(r.mode, 'daily');
  assert.deepEqual(r.suspectBleed, { date: '2026-06-08', reason: 'isolated_heavy' });
});
test('断档 ≤1 天仍算同一段参与判定，≥2 天不合并', () => {
  // light 06-05 + heavy 06-07（缺 06-06）→ 同段 2 天含 heavy → 经期，Day1 = 06-07
  let r = deriveState(
    [
      { event: 'bleed_light', date: '2026-06-05' },
      { event: 'bleed_heavy', date: '2026-06-07' },
    ],
    '2026-06-07',
    cfg
  );
  assert.equal(r.mode, 'period');
  assert.equal(r.periodStart, '2026-06-07');
  // 断 3 天 → 不合并：heavy 落单 → 不开经期，转疑似询问
  r = deriveState(
    [
      { event: 'bleed_light', date: '2026-06-03' },
      { event: 'bleed_heavy', date: '2026-06-07' },
    ],
    '2026-06-07',
    cfg
  );
  assert.equal(r.mode, 'daily');
  assert.equal(r.suspectBleed.reason, 'isolated_heavy');
});
test('孤立 bleed_light 永远不开启经期、也不触发询问', () => {
  const r = deriveState([{ event: 'bleed_light', date: '2026-06-10' }], '2026-06-10', cfg);
  assert.equal(r.mode, 'daily');
  assert.equal(r.spottingToday, true);
  assert.equal(r.suspectBleed, null);
});
test('持续报血可顺延默认 5 天的兜底结束', () => {
  const events = ['01', '02', '03', '04', '05', '06', '07'].map((d) => ({
    event: 'bleed_heavy',
    date: `2026-06-${d}`,
  }));
  const r = deriveState(events, '2026-06-07', cfg); // 默认兜底本应 06-05 结束
  assert.equal(r.mode, 'period');
  assert.equal(r.dayN, 7);
});
test('口头报结束优先于兜底 + daysSinceEnd 起算', () => {
  const events = [
    { event: 'bleed_heavy', date: '2026-06-03' },
    { event: 'bleed_heavy', date: '2026-06-04' },
    { event: 'period_end', date: '2026-06-09' },
  ];
  assert.equal(deriveState(events, '2026-06-09', cfg).mode, 'period');
  const r = deriveState(events, '2026-06-12', cfg);
  assert.equal(r.mode, 'daily');
  assert.equal(r.daysSinceEnd, 3);
});
test('not_period 否决自动判定，且不再追问', () => {
  const events = [
    { event: 'bleed_heavy', date: '2026-06-08' },
    { event: 'bleed_heavy', date: '2026-06-09' },
    { event: 'not_period', date: '2026-06-09' },
  ];
  const r = deriveState(events, '2026-06-09', cfg);
  assert.equal(r.mode, 'daily');
  assert.equal(r.spottingToday, true);
  assert.equal(r.suspectBleed, null);
});
test('宣告冲突以较晚者为准，同日否认赢', () => {
  // 否认之后又宣告 → 翻案成经期，Day1 = 新宣告日
  const events = [
    { event: 'bleed_heavy', date: '2026-06-08' },
    { event: 'not_period', date: '2026-06-08' },
    { event: 'bleed_heavy', date: '2026-06-09' },
    { event: 'period_start', date: '2026-06-09' },
  ];
  const r = deriveState(events, '2026-06-09', cfg);
  assert.equal(r.mode, 'period');
  assert.equal(r.periodStart, '2026-06-09');
  // 同日平手：否认赢（"说错了"通常是更正刚才的宣告）
  const r2 = deriveState(
    [
      { event: 'period_start', date: '2026-06-08' },
      { event: 'not_period', date: '2026-06-08' },
    ],
    '2026-06-08',
    cfg
  );
  assert.equal(r2.mode, 'daily');
});
test('旧数据兼容：单条 period_start 行为不变；与同日 bleed_heavy 并存不混乱', () => {
  let r = deriveState([{ event: 'period_start', date: '2026-06-09' }], '2026-06-10', cfg);
  assert.equal(r.mode, 'period');
  assert.equal(r.dayN, 2);
  r = deriveState(
    [
      { event: 'period_start', date: '2026-06-08' },
      { event: 'bleed_heavy', date: '2026-06-08' },
    ],
    '2026-06-09',
    cfg
  );
  assert.equal(r.mode, 'period');
  assert.equal(r.periodStart, '2026-06-08');
  assert.equal(r.dayN, 2);
});
test('安全网二：经期结束后 5 天内再出血 → 挂起自动判定 + 询问；确认后成新经期', () => {
  const events = [
    { event: 'period_start', date: '2026-06-01' },
    { event: 'period_end', date: '2026-06-05' },
    { event: 'bleed_heavy', date: '2026-06-08' },
    { event: 'bleed_heavy', date: '2026-06-09' },
  ];
  const r = deriveState(events, '2026-06-09', cfg);
  assert.equal(r.mode, 'daily'); // ≥2 天含 heavy 本应自动判，但落在 5 天窗内 → 只问不判
  assert.equal(r.spottingToday, true);
  assert.deepEqual(r.suspectBleed, { date: '2026-06-08', reason: 'post_period' });
  // 主人点头"是月经" → 新经期 Day1 = 确认日期
  events.push({ event: 'period_start', date: '2026-06-08' });
  const r2 = deriveState(events, '2026-06-09', cfg);
  assert.equal(r2.mode, 'period');
  assert.equal(r2.periodStart, '2026-06-08');
  assert.equal(r2.dayN, 2);
});
test('period_end 之后同段又出血 → 拆出残段进入疑似询问', () => {
  const events = [
    { event: 'period_start', date: '2026-06-01' },
    { event: 'bleed_heavy', date: '2026-06-02' },
    { event: 'bleed_heavy', date: '2026-06-03' },
    { event: 'period_end', date: '2026-06-03' },
    { event: 'bleed_light', date: '2026-06-05' },
  ];
  const r = deriveState(events, '2026-06-05', cfg);
  assert.equal(r.mode, 'daily');
  assert.equal(r.daysSinceEnd, 2);
  assert.equal(r.spottingToday, true);
  assert.deepEqual(r.suspectBleed, { date: '2026-06-05', reason: 'post_period' });
});
test('未来日期的事件不影响今天', () => {
  const events = [
    { event: 'bleed_heavy', date: '2026-06-20' },
    { event: 'pms_start', date: '2026-06-15' },
  ];
  assert.equal(deriveState(events, '2026-06-10', cfg).mode, 'daily');
});
test('backfillStart：经期第 3 天 → start = 今天-2', () => {
  assert.equal(backfillStart('2026-06-10', 3), '2026-06-08');
});

console.log('cycle.js（PMS）');
test('pms_start 进入 PMS，经期开始终结，maxDays 兜底', () => {
  const events = [{ event: 'pms_start', date: '2026-06-01' }];
  assert.equal(deriveState(events, '2026-06-05', cfg).mode, 'pms');
  events.push({ event: 'period_start', date: '2026-06-08' });
  assert.equal(deriveState(events, '2026-06-08', cfg).mode, 'period');
  assert.equal(deriveState(events, '2026-06-14', cfg).mode, 'daily'); // 不回 PMS
  assert.equal(
    deriveState([{ event: 'pms_start', date: '2026-05-20' }], '2026-06-03', cfg).mode,
    'daily' // 第 14 天兜底过期
  );
});

console.log('cycle.js（排卵与预测）');
test('排卵日 = 果冻段末 + 1；段进行中待定，消退后自动落定', () => {
  const events = [
    { event: 'jelly', date: '2026-06-06' },
    { event: 'jelly', date: '2026-06-07' },
    { event: 'jelly', date: '2026-06-08' },
  ];
  // 段进行中（今天也有果冻）：排卵日空着，诚实优先
  let r = deriveState(events, '2026-06-08', cfg);
  assert.equal(r.ovulationDate, null);
  assert.equal(r.ovulationPending, true);
  assert.equal(r.daysSinceOvulation, null);
  assert.equal(r.predictedPeriod, null);
  assert.equal(r.phase, 'ovulation');
  // 黏液消退：排卵日落定 = 段末+1 = 06-09
  r = deriveState(events, '2026-06-10', cfg);
  assert.equal(r.ovulationDate, '2026-06-09');
  assert.equal(r.ovulationPending, false);
  assert.equal(r.daysSinceOvulation, 1);
});
test('排卵期显示 = 段第 2 天到排卵日当天；黄体期紧随其后，距排卵日 21 天兜底', () => {
  const events = [
    { event: 'jelly', date: '2026-06-06' },
    { event: 'jelly', date: '2026-06-07' },
  ];
  assert.equal(deriveState(events, '2026-06-06', cfg).phase, 'normal'); // 第一天还看不出连续
  assert.equal(deriveState(events, '2026-06-07', cfg).phase, 'ovulation');
  assert.equal(deriveState(events, '2026-06-08', cfg).phase, 'ovulation'); // 排卵日（段末+1）当天
  assert.equal(deriveState(events, '2026-06-09', cfg).phase, 'luteal'); // 无空窗衔接
  assert.equal(deriveState(events, '2026-06-29', cfg).phase, 'luteal'); // 距排卵日第 21 天仍黄体
  assert.equal(deriveState(events, '2026-06-30', cfg).phase, 'normal'); // 超 21 天兜底
});
test('单日果冻不构成排卵期', () => {
  const events = [{ event: 'jelly', date: '2026-06-07' }];
  assert.equal(deriveState(events, '2026-06-07', cfg).phase, 'normal');
  assert.equal(deriveState(events, '2026-06-09', cfg).phase, 'normal');
});
test('排卵日当天补果冻：phase 稳定为排卵期，排卵日顺延待定', () => {
  const events = [
    { event: 'jelly', date: '2026-06-05' },
    { event: 'jelly', date: '2026-06-06' },
    { event: 'jelly', date: '2026-06-07' },
  ];
  assert.equal(deriveState(events, '2026-06-08', cfg).phase, 'ovulation'); // 排卵日当天
  events.push({ event: 'jelly', date: '2026-06-08' }); // 当天又记到果冻
  const r = deriveState(events, '2026-06-08', cfg);
  assert.equal(r.phase, 'ovulation'); // 不跳变
  assert.equal(r.ovulationPending, true);
});
test('预测经期 = 窗口 [排卵+14, 排卵+21]，窗口划过即清空', () => {
  const events = [
    { event: 'jelly', date: '2026-06-01' },
    { event: 'jelly', date: '2026-06-02' },
  ];
  // 排卵日 06-03
  const r = deriveState(events, '2026-06-05', cfg);
  assert.deepEqual(r.predictedPeriod, { start: '2026-06-17', end: '2026-06-24' });
  assert.equal(deriveState(events, '2026-06-25', cfg).predictedPeriod, null);
});
test('孤立 heavy 落在预测窗口内先不问（等次日续上），窗口划过仍孤立则补问', () => {
  const events = [
    { event: 'jelly', date: '2026-06-01' },
    { event: 'jelly', date: '2026-06-02' },
    { event: 'bleed_heavy', date: '2026-06-18' }, // 窗口 06-17~06-24 内
  ];
  assert.equal(deriveState(events, '2026-06-19', cfg).suspectBleed, null);
  assert.equal(deriveState(events, '2026-06-25', cfg).suspectBleed.reason, 'isolated_heavy');
});
test('完成使命：经期来了，这次排卵的派生信息全部清空', () => {
  const events = [
    { event: 'jelly', date: '2026-06-01' },
    { event: 'jelly', date: '2026-06-02' },
    { event: 'period_start', date: '2026-06-18' },
  ];
  const r = deriveState(events, '2026-06-19', cfg);
  assert.equal(r.mode, 'period');
  assert.equal(r.daysSinceOvulation, null);
  assert.equal(r.predictedPeriod, null);
  assert.equal(deriveState(events, '2026-06-24', cfg).phase, 'normal'); // 经期结束后不回黄体
});

console.log('ai.js 白名单过滤');
test('不在应服清单内的 intake 项被丢弃', () => {
  const checklist = getChecklist('daily');
  const filtered = filterIntakeToChecklist(
    [
      { supplement: 'VC', slot: 'lunch', taken: true },
      { supplement: '人参', slot: 'lunch', taken: true }, // AI 编造
      { supplement: 'VC', slot: 'wake', taken: true }, // slot 不符
    ],
    checklist
  );
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].supplement, 'VC');
  assert.equal(filtered[0].dose, '500 mg'); // 剂量快照来自清单，不信 AI
});
test('sanitizeRemove：cycle_events 过滤编造项、去重、空则整体置 null', () => {
  const r = sanitizeRemove({
    what: 'cycle_events',
    items: [
      { event: 'period_start', date: '2026-06-09' },
      { event: 'period_start', date: '2026-06-09' }, // 重复
      { event: '人参', date: '2026-06-09' }, // 编造事件
      { event: 'bleed_heavy', date: '06-09' }, // 非法日期
    ],
  });
  assert.deepEqual(r, { what: 'cycle_events', items: [{ event: 'period_start', date: '2026-06-09' }] });
  assert.equal(sanitizeRemove({ what: 'cycle_events', items: [{ event: 'x', date: 'y' }] }), null);
  assert.deepEqual(sanitizeRemove({ what: 'last' }), { what: 'last' });
});
test('sanitizeRemove：symptom_entries 校验日期与症状名', () => {
  const r = sanitizeRemove({
    what: 'symptom_entries',
    items: [
      { date: '2026-06-09', symptom: ' 胸胀 ' },
      { date: '2026-06-09', symptom: '胸胀' }, // trim 后重复
      { date: '6/9', symptom: '头痛' }, // 非法日期
      { date: '2026-06-09', symptom: '' }, // 空名
    ],
  });
  assert.deepEqual(r, { what: 'symptom_entries', items: [{ date: '2026-06-09', symptom: '胸胀' }] });
});
test('又删又记的矛盾条目：删除优先，剔除重复新增', () => {
  const remove = { what: 'cycle_events', items: [{ event: 'pms_start', date: '2026-06-09' }] };
  const cycles = [
    { event: 'pms_start', date: '2026-06-09' }, // 与删除完全相同 → 剔除
    { event: 'jelly', date: '2026-06-09' }, // 不同事件 → 保留
  ];
  assert.deepEqual(dropContradictoryCycles(cycles, remove), [{ event: 'jelly', date: '2026-06-09' }]);
  assert.deepEqual(dropContradictoryCycles(cycles, { what: 'cycle_today' }), cycles); // 其他删除形态不动
});
test('已确认过的周期条目不再进预览（防上文重复输出）', () => {
  const existing = [{ event: 'jelly', date: '2026-06-11' }];
  const cycles = [
    { event: 'jelly', date: '2026-06-11' }, // 已入库 → 滤掉
    { event: 'period_start', date: '2026-06-11' }, // 新内容 → 保留
  ];
  assert.deepEqual(dropExistingCycles(cycles, existing), [{ event: 'period_start', date: '2026-06-11' }]);
  assert.deepEqual(dropExistingCycles(cycles, undefined), cycles); // 无上下文不过滤
});
test('删除意图防火墙：话里没有删除字眼时丢弃 remove', () => {
  const rm = { what: 'cycle_events', items: [{ event: 'bleed_light', date: '2026-06-09' }] };
  assert.equal(removeRequiresIntent(rm, '前天开始流血'), null); // 纯记录话术 → 丢弃
  assert.deepEqual(removeRequiresIntent(rm, '把9号的出血删掉'), rm);
  assert.deepEqual(removeRequiresIntent(rm, '搞错了，今天不是经期'), rm);
  assert.deepEqual(removeRequiresIntent(rm, '撤销刚才那条'), rm);
  assert.deepEqual(removeRequiresIntent(rm, '把那条移除'), rm);
  assert.deepEqual(removeRequiresIntent(rm, '说错了，9号没出血'), rm);
  assert.deepEqual(removeRequiresIntent(rm, '抹掉6号的'), rm);
  assert.equal(removeRequiresIntent(null, '随便说点什么'), null);
});

console.log(`\n合计 ${passed} tests passed`);
