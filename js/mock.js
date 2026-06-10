// 本地演示/验证层：URL 加 ?mock=1 启用。
// 全部数据在内存里，不发任何网络请求——保证测试绝不碰真实数据库。

import { getChecklist } from './protocol.js';

export function makeMockDb() {
  const intake = new Map(); // key: date|supplement|slot
  const symptoms = new Map(); // key: date|symptom
  const cycleEvents = [{ event: 'period_start', date: '2026-05-20' }];
  const catalog = ['胸胀', '噩梦', '情绪低落', '精力', '头痛', '腹痛', '发热感'];

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
    insertCycleEvent: async (e) => {
      if (!cycleEvents.some((x) => x.event === e.event && x.date === e.date)) cycleEvents.push(e);
      return null;
    },
    fetchCycleEvents: async () => [...cycleEvents],
    fetchFixedSymptoms: async () => catalog.map((name) => ({ name })),
    bumpSymptomCatalog: async () => {},
  };
}

// 模拟 AI：识别几句典型话术，足够走通预览/clarify/error 全分支
export function mockParse(text, context) {
  return new Promise((resolve, reject) => {
    setTimeout(() => {
      if (text.includes('崩溃')) return reject(new Error('mock failure'));
      if (text.includes('不知道')) {
        return resolve({ intake: [], symptoms: [], cycle: null, clarify: '你是想记补剂还是症状呀？' });
      }
      const checklist = context.checklist || getChecklist(context.mode);
      const result = { intake: [], symptoms: [], cycle: null, clarify: null };
      if (text.includes('都吃了')) {
        result.intake = checklist.map((c) => ({ supplement: c.supplement, slot: c.slot, taken: true }));
      }
      if (text.includes('漏了VC') || text.includes('没吃VC')) {
        result.intake = checklist.map((c) => ({
          supplement: c.supplement,
          slot: c.slot,
          taken: c.supplement !== 'VC',
        }));
      }
      if (text.includes('胸胀')) result.symptoms.push({ symptom: '胸胀', severity: 2, is_custom: false });
      if (text.includes('情绪')) result.symptoms.push({ symptom: '情绪低落', severity: 2, is_custom: false });
      if (text.includes('膝盖疼')) result.symptoms.push({ symptom: '膝盖疼', severity: 1, is_custom: true });
      if (text.includes('来了') || text.includes('例假')) {
        result.cycle = { event: 'period_start', date: context.date };
      }
      if (text.includes('结束') || text.includes('走了')) {
        result.cycle = { event: 'period_end', date: context.date };
      }
      if (text.toLowerCase().includes('pms')) {
        result.cycle = { event: 'pms_start', date: context.date };
      }
      if (text.includes('有点血') || text.includes('见红')) {
        result.cycle = { event: 'spotting', date: context.date };
      }
      if (text.includes('果冻') || text.includes('蛋清') || text.includes('拉丝')) {
        result.cycle = { event: 'ovulation_sign', date: context.date };
      }
      resolve(result);
    }, 600);
  });
}
