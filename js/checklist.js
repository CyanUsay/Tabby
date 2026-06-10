// 今日清单：按 slot 分组渲染，大圆点手动勾选（不依赖 AI 的兜底路径）。

import { SLOTS, SLOT_LABELS } from './protocol.js';

export function intakeKey(item) {
  return `${item.supplement}|${item.slot}`;
}

// checklist: 应服清单；intakeMap: Map<key, {taken}>；onToggle(item, nextTaken)
export function renderChecklist(container, checklist, intakeMap, onToggle) {
  container.innerHTML = '';
  for (const slot of SLOTS) {
    const items = checklist.filter((i) => i.slot === slot);
    if (!items.length) continue;
    const label = document.createElement('div');
    label.className = 'slot-label';
    label.textContent = SLOT_LABELS[slot];
    container.appendChild(label);
    for (const item of items) {
      const row = intakeMap.get(intakeKey(item));
      const taken = row ? row.taken : false;
      const btn = document.createElement('button');
      btn.className = `intake-row${taken ? ' taken' : ''}`;
      btn.innerHTML = `
        <span class="dot">✓</span>
        <span class="name"></span>
        <span class="dose"></span>`;
      btn.querySelector('.name').textContent = item.supplement;
      btn.querySelector('.dose').textContent = item.dose;
      btn.addEventListener('click', () => onToggle(item, !taken));
      container.appendChild(btn);
    }
  }
}
