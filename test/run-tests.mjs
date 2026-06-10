// 纯函数测试：node test/run-tests.mjs
// 只测 dates/protocol/cycle/白名单过滤，绝不接触网络或数据库。

import assert from 'node:assert/strict';
import { appToday, addDays, diffDays, weekOf } from '../js/dates.js';
import { getChecklist, SLOTS } from '../js/protocol.js';
import { deriveMode, backfillStart } from '../js/cycle.js';
import { filterIntakeToChecklist } from '../js/ai.js';

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`  ok - ${name}`);
}

const cfg = { periodLength: 5, pmsMaxDays: 14 };

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

console.log('cycle.js');
test('无事件 → daily', () => {
  assert.deepEqual(deriveMode([], '2026-06-10', cfg), {
    mode: 'daily',
    dayN: null,
    daysSinceEnd: null,
    ovulating: false,
  });
});
test('经期窗口内（无显式 end，默认长度兜底）→ period Day N', () => {
  const events = [{ event: 'period_start', date: '2026-06-08' }];
  const r = deriveMode(events, '2026-06-10', cfg);
  assert.equal(r.mode, 'period');
  assert.equal(r.dayN, 3);
  assert.equal(r.daysSinceEnd, null);
});
test('默认长度兜底：第 6 天回 daily，经期结束后 1 天', () => {
  const events = [{ event: 'period_start', date: '2026-06-05' }];
  // 隐含结束日 = 06-09
  const r = deriveMode(events, '2026-06-10', cfg);
  assert.equal(r.mode, 'daily');
  assert.equal(r.daysSinceEnd, 1);
});
test('显式 end 延长经期窗口 + daysSinceEnd 从显式 end 起算', () => {
  const events = [
    { event: 'period_start', date: '2026-06-03' },
    { event: 'period_end', date: '2026-06-09' },
  ];
  assert.equal(deriveMode(events, '2026-06-09', cfg).mode, 'period');
  const r = deriveMode(events, '2026-06-12', cfg);
  assert.equal(r.mode, 'daily');
  assert.equal(r.daysSinceEnd, 3);
});
test('pms_start 报告后进入 PMS，经期开始后终结', () => {
  const events = [{ event: 'pms_start', date: '2026-06-01' }];
  assert.equal(deriveMode(events, '2026-06-05', cfg).mode, 'pms');
  events.push({ event: 'period_start', date: '2026-06-08' });
  assert.equal(deriveMode(events, '2026-06-08', cfg).mode, 'period');
  // 经期结束后不再回到 PMS（pms_start 已被这次经期终结）
  assert.equal(deriveMode(events, '2026-06-14', cfg).mode, 'daily');
});
test('PMS 超过 pmsMaxDays 自动回 daily（忘记报经期的兜底）', () => {
  const events = [{ event: 'pms_start', date: '2026-05-20' }];
  assert.equal(deriveMode(events, '2026-06-02', cfg).mode, 'pms'); // 第 13 天
  assert.equal(deriveMode(events, '2026-06-03', cfg).mode, 'daily'); // 第 14 天
});
test('spotting 不影响 mode', () => {
  const events = [{ event: 'spotting', date: '2026-06-09' }];
  assert.equal(deriveMode(events, '2026-06-10', cfg).mode, 'daily');
});
test('排卵信号 3 天内 ovulating=true，之后 false', () => {
  const events = [{ event: 'ovulation_sign', date: '2026-06-08' }];
  assert.equal(deriveMode(events, '2026-06-10', cfg).ovulating, true);
  assert.equal(deriveMode(events, '2026-06-11', cfg).ovulating, false);
});
test('未来日期的事件不影响今天', () => {
  const events = [
    { event: 'period_start', date: '2026-06-20' },
    { event: 'pms_start', date: '2026-06-15' },
  ];
  assert.equal(deriveMode(events, '2026-06-10', cfg).mode, 'daily');
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
