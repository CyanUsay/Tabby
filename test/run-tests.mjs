// 纯函数测试：node test/run-tests.mjs
// 只测 dates/protocol/cycle/白名单过滤，绝不接触网络或数据库。

import assert from 'node:assert/strict';
import { appToday, addDays, diffDays, weekOf } from '../js/dates.js';
import { getChecklist, SLOTS } from '../js/protocol.js';
import { deriveState, backfillStart } from '../js/cycle.js';
import { filterIntakeToChecklist } from '../js/ai.js';

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`  ok - ${name}`);
}

const cfg = { periodLength: 5, pmsMaxDays: 14, bleedGapDays: 1 };

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

console.log('cycle.js（观察驱动推算器）');
test('无事件 → daily', () => {
  const r = deriveState([], '2026-06-10', cfg);
  assert.equal(r.mode, 'daily');
  assert.equal(r.daysSinceEnd, null);
  assert.equal(r.daysSinceOvulation, null);
});
test('bleed_heavy → period Day N（默认长度兜底）', () => {
  const events = [{ event: 'bleed_heavy', date: '2026-06-08' }];
  const r = deriveState(events, '2026-06-10', cfg);
  assert.equal(r.mode, 'period');
  assert.equal(r.dayN, 3);
});
test('核心回溯：light light → heavy，Day1 回溯到出血段第一天', () => {
  const events = [
    { event: 'bleed_light', date: '2026-06-08' },
    { event: 'bleed_light', date: '2026-06-09' },
  ];
  // 只有 light：不是经期，今天是不正出血
  let r = deriveState(events, '2026-06-09', cfg);
  assert.equal(r.mode, 'daily');
  assert.equal(r.spottingToday, true);
  // 血量上来：整段并入经期，Day1 = 06-08
  events.push({ event: 'bleed_heavy', date: '2026-06-10' });
  r = deriveState(events, '2026-06-10', cfg);
  assert.equal(r.mode, 'period');
  assert.equal(r.periodStart, '2026-06-08');
  assert.equal(r.dayN, 3);
});
test('断档 ≤1 天仍算同一段，≥2 天不合并', () => {
  // 06-05 light，06-07 heavy：中间缺 06-06 一天 → 合并，Day1=06-05
  let r = deriveState(
    [
      { event: 'bleed_light', date: '2026-06-05' },
      { event: 'bleed_heavy', date: '2026-06-07' },
    ],
    '2026-06-07',
    cfg
  );
  assert.equal(r.periodStart, '2026-06-05');
  // 06-03 light，06-07 heavy：断 3 天 → 不合并，light 是孤立不正出血
  r = deriveState(
    [
      { event: 'bleed_light', date: '2026-06-03' },
      { event: 'bleed_heavy', date: '2026-06-07' },
    ],
    '2026-06-07',
    cfg
  );
  assert.equal(r.periodStart, '2026-06-07');
  assert.equal(r.dayN, 1);
});
test('孤立 bleed_light 永远不开启经期', () => {
  const r = deriveState([{ event: 'bleed_light', date: '2026-06-10' }], '2026-06-10', cfg);
  assert.equal(r.mode, 'daily');
  assert.equal(r.spottingToday, true);
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
    { event: 'period_end', date: '2026-06-09' },
  ];
  assert.equal(deriveState(events, '2026-06-09', cfg).mode, 'period');
  const r = deriveState(events, '2026-06-12', cfg);
  assert.equal(r.mode, 'daily');
  assert.equal(r.daysSinceEnd, 3);
});
test('旧数据 period_start 等价于 bleed_heavy', () => {
  const r = deriveState([{ event: 'period_start', date: '2026-06-09' }], '2026-06-10', cfg);
  assert.equal(r.mode, 'period');
  assert.equal(r.dayN, 2);
});
test('pms_start 进入 PMS，经期开始终结，maxDays 兜底', () => {
  const events = [{ event: 'pms_start', date: '2026-06-01' }];
  assert.equal(deriveState(events, '2026-06-05', cfg).mode, 'pms');
  events.push({ event: 'bleed_heavy', date: '2026-06-08' });
  assert.equal(deriveState(events, '2026-06-08', cfg).mode, 'period');
  assert.equal(deriveState(events, '2026-06-14', cfg).mode, 'daily'); // 不回 PMS
  assert.equal(
    deriveState([{ event: 'pms_start', date: '2026-05-20' }], '2026-06-03', cfg).mode,
    'daily' // 第 14 天兜底过期
  );
});
test('排卵 = 果冻连续段最后一天，进行中暂记今天', () => {
  const events = [
    { event: 'jelly', date: '2026-06-06' },
    { event: 'jelly', date: '2026-06-07' },
    { event: 'jelly', date: '2026-06-08' },
  ];
  // 段进行中（今天也有果冻）
  assert.equal(deriveState(events, '2026-06-08', cfg).daysSinceOvulation, 0);
  // 段已结束：排卵落定 06-08，今天是排卵后 2 天
  const r = deriveState(events, '2026-06-10', cfg);
  assert.equal(r.ovulationDate, '2026-06-08');
  assert.equal(r.daysSinceOvulation, 2);
});
test('经期来过之后，排卵计数不再显示', () => {
  const events = [
    { event: 'jelly', date: '2026-05-25' },
    { event: 'bleed_heavy', date: '2026-06-08' },
  ];
  assert.equal(deriveState(events, '2026-06-10', cfg).daysSinceOvulation, null);
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

console.log(`\n${passed} tests passed`);
