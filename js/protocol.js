// 补剂方案（spec §1）。改方案只改这个文件，push 后 bump sw.js 版本号即可。

export const SLOTS = ['wake', 'lunch', 'dinner', 'bedtime'];
export const SLOT_LABELS = { wake: '睡醒', lunch: '午饭后', dinner: '晚饭后', bedtime: '睡前' };

const DAILY = [
  { supplement: 'DHC B群', slot: 'wake', dose: '推荐量一半' },
  { supplement: 'VD', slot: 'lunch', dose: '5000 IU' },
  { supplement: 'VA', slot: 'lunch', dose: '2500 单位' },
  { supplement: '鱼油', slot: 'lunch', dose: '1 颗' },
  { supplement: 'VC', slot: 'lunch', dose: '500 mg' },
  { supplement: 'VC', slot: 'dinner', dose: '500 mg' },
  { supplement: 'VE', slot: 'dinner', dose: '200 mg' },
  { supplement: '鱼油', slot: 'dinner', dose: '1 颗' },
  { supplement: '甘氨酸镁', slot: 'bedtime', dose: '200 mg' },
];

// overlay 语义：override 按 (supplement, slot) 覆盖剂量；add 追加条目
const OVERLAYS = {
  pms: {
    add: [{ supplement: 'B6', slot: 'lunch', dose: '2 片（约 35 mg）' }],
    override: [{ supplement: '甘氨酸镁', slot: 'bedtime', dose: '300 mg' }],
  },
  period: {
    add: [],
    override: [
      // 鱼油全天合计加到 3 颗（EPA 540mg + DHA 360mg）
      { supplement: '鱼油', slot: 'lunch', dose: '2 颗' },
      { supplement: '鱼油', slot: 'dinner', dose: '1 颗' },
      { supplement: '甘氨酸镁', slot: 'bedtime', dose: '300 mg' },
      // B6 回到 DHC B群自带的 15mg，不额外补，故无 add 项
    ],
  },
};

// 当天应服清单：[{supplement, slot, dose}]，按 SLOTS 顺序排列。
// 同一份数据既渲染 UI 也注入 AI prompt（单一数据源）。
export function getChecklist(mode) {
  const overlay = OVERLAYS[mode];
  let list = DAILY.map((item) => ({ ...item }));
  if (overlay) {
    for (const o of overlay.override) {
      const hit = list.find((i) => i.supplement === o.supplement && i.slot === o.slot);
      if (hit) hit.dose = o.dose;
      else list.push({ ...o });
    }
    list = list.concat(overlay.add.map((item) => ({ ...item })));
  }
  return list.sort((a, b) => SLOTS.indexOf(a.slot) - SLOTS.indexOf(b.slot));
}
