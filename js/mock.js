// 本地演示/验证层：URL 加 ?mock=1 启用。
// 全部数据在内存里，不发任何网络请求——保证测试绝不碰真实数据库。

import { getChecklist } from './protocol.js';

export function makeMockDb() {
  const intake = new Map(); // key: date|supplement|slot
  const symptoms = new Map(); // key: date|symptom
  // 演示用历史：让双周日历能看到荧光笔和下划线
  let cycleEvents = [
    { event: 'period_start', date: '2026-05-20' },
    { event: 'bleed_light', date: '2026-06-02' },
    { event: 'jelly', date: '2026-06-05' },
    { event: 'jelly', date: '2026-06-06' },
    { event: 'jelly', date: '2026-06-07' },
    { event: 'pms_start', date: '2026-06-09' },
  ];
  // PMS 色带浓度演示：06-09 明显（中度）→ 100%，06-10 轻（两项轻）→ 75%，今天没记 → 50%
  symptoms.set('2026-06-09|胸胀', { date: '2026-06-09', symptom: '胸胀', severity: 2, is_custom: false });
  symptoms.set('2026-06-10|情绪低落', { date: '2026-06-10', symptom: '情绪低落', severity: 1, is_custom: false });
  symptoms.set('2026-06-10|睡眠障碍', { date: '2026-06-10', symptom: '睡眠障碍', severity: 1, is_custom: false });
  const catalog = ['胸胀', '睡眠障碍', '情绪低落', '精力', '头痛', '腹痛', '发热感'];

  return {
    fetchTodayIntake: async (date) =>
      [...intake.values()].filter((r) => r.date === date),
    upsertIntake: async (rows) => {
      for (const r of rows) intake.set(`${r.date}|${r.supplement}|${r.slot}`, { ...r });
      return rows;
    },
    upsertSymptoms: async (rows) => {
      for (const r of rows) symptoms.set(`${r.date}|${r.symptom}`, { ...r });
      return rows;
    },
    fetchTodaySymptoms: async (date) =>
      [...symptoms.values()].filter((r) => r.date === date),
    fetchSymptomsRange: async (from, to) =>
      [...symptoms.values()].filter((r) => r.date >= from && r.date <= to),
    insertCycleEvent: async (e) => {
      if (!cycleEvents.some((x) => x.event === e.event && x.date === e.date)) cycleEvents.push(e);
      return null;
    },
    fetchCycleEvents: async () => [...cycleEvents],
    fetchFixedSymptoms: async () => catalog.map((name) => ({ name })),
    bumpSymptomCatalog: async () => {},
    deleteCycleEvent: async ({ event, date }) => {
      cycleEvents = cycleEvents.filter((x) => !(x.event === event && x.date === date));
    },
    deleteCycleEventsByDate: async (date) => {
      cycleEvents = cycleEvents.filter((x) => x.date !== date);
    },
    deleteSymptom: async (date, symptom) => {
      symptoms.delete(`${date}|${symptom}`);
    },
    deleteSymptomsByDate: async (date) => {
      for (const k of [...symptoms.keys()]) if (k.startsWith(`${date}|`)) symptoms.delete(k);
    },
  };
}

// 模拟 AI：识别几句典型话术，足够走通预览/clarify/error/撤销 全分支
export function mockParse(text, context) {
  return new Promise((resolve, reject) => {
    setTimeout(() => {
      if (text.includes('崩溃')) return reject(new Error('mock failure'));
      if (text.includes('不知道')) {
        return resolve({ intake: [], symptoms: [], cycle: null, remove: null, clarify: '主人是想记补剂还是症状呀喵？ฅ(•ㅅ•)ฅ' });
      }
      const checklist = context.checklist || getChecklist(context.mode);
      const result = { intake: [], symptoms: [], cycle: null, remove: null, clarify: null };

      // 撤销/删除
      if (text.includes('删掉') || text.includes('删除') || text.includes('撤销')) {
        const sym = ['胸胀', '头痛', '睡眠障碍', '情绪低落'].find((s) => text.includes(s));
        if (sym) result.remove = { what: 'symptom_entries', items: [{ date: context.date, symptom: sym }] };
        else if (text.includes('症状')) result.remove = { what: 'symptoms_today' };
        else if (text.includes('整个') && (text.includes('经期') || text.includes('月经'))) {
          // 模拟真 prompt：从 context.cycleEvents 里挑出经期相关条目逐条删
          const items = (context.cycleEvents ?? []).filter((e) =>
            ['period_start', 'bleed_heavy', 'bleed_light', 'period_end'].includes(e.event));
          result.remove = { what: 'cycle_events', items };
        } else if (text.includes('周期') || text.includes('经期')) {
          result.remove = { what: 'cycle_today' };
        } else result.remove = { what: 'last' };
        return resolve(result);
      }
      if (text.includes('不是经期')) {
        result.remove = { what: 'cycle_today' };
        return resolve(result);
      }

      // 局部打卡："晚饭的吃了" / "刚吃了镁"
      if (text.includes('晚饭') && text.includes('吃')) {
        result.intake = checklist
          .filter((c) => c.slot === 'dinner')
          .map((c) => ({ supplement: c.supplement, slot: c.slot, taken: true }));
      } else if (text.includes('吃了镁') || text.includes('刚吃了镁')) {
        result.intake = checklist
          .filter((c) => c.supplement === '甘氨酸镁')
          .map((c) => ({ supplement: c.supplement, slot: c.slot, taken: true }));
      } else if (text.includes('都吃了')) {
        result.intake = checklist.map((c) => ({ supplement: c.supplement, slot: c.slot, taken: true }));
        if (text.includes('漏了VC') || text.includes('没吃VC')) {
          result.intake = result.intake.map((i) => ({ ...i, taken: i.supplement !== 'VC' }));
        }
      }

      if (text.includes('胸胀')) result.symptoms.push({ symptom: '胸胀', severity: 2, is_custom: false });
      if (text.includes('头痛')) result.symptoms.push({ symptom: '头痛', severity: 2, is_custom: false });
      if (text.includes('失眠') || text.includes('噩梦') || text.includes('吓醒')) {
        result.symptoms.push({ symptom: '睡眠障碍', severity: 2, is_custom: false });
      }
      if (text.includes('膝盖疼')) result.symptoms.push({ symptom: '膝盖疼', severity: 1, is_custom: true });

      if (text.includes('不是月经') || text.includes('不是例假')) {
        result.cycle = { event: 'not_period', date: context.date };
      } else if (text.includes('例假') || text.includes('月经')) {
        result.cycle = { event: 'period_start', date: context.date }; // 亲口宣告
      } else if (text.includes('量多')) {
        result.cycle = { event: 'bleed_heavy', date: context.date }; // 纯血量观察
      }
      if (text.includes('结束') || text.includes('走了')) {
        result.cycle = { event: 'period_end', date: context.date };
      }
      if (text.toLowerCase().includes('pms')) {
        result.cycle = { event: 'pms_start', date: context.date };
      }
      if (text.includes('有点血') || text.includes('见红') || text.includes('少量出血')) {
        result.cycle = { event: 'bleed_light', date: context.date };
      }
      if (text.includes('昨天') && text.includes('血')) {
        const d = new Date(context.date); d.setDate(d.getDate() - 1);
        const y = d.toISOString().slice(0, 10);
        result.cycle = [{ event: 'bleed_light', date: y }, { event: 'bleed_light', date: context.date }];
      }
      if (text.includes('果冻') || text.includes('蛋清') || text.includes('拉丝')) {
        if (text.includes('这两天') || text.includes('昨天')) {
          const d = new Date(context.date); d.setDate(d.getDate() - 1);
          result.cycle = [{ event: 'jelly', date: d.toISOString().slice(0, 10) }, { event: 'jelly', date: context.date }];
        } else {
          result.cycle = { event: 'jelly', date: context.date };
        }
      }
      resolve(result);
    }, 600);
  });
}
