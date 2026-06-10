// 今日安排：每个时段一张玻璃卡，默认折叠（只显卡头），点卡头展开补剂明细。
// 卡头右侧状态圆 = 整时段全勾/全取消（不展开也能打卡）；明细行可单独勾选。

import { SLOTS, SLOT_LABELS } from './protocol.js';

export const SLOT_META = {
  wake: { icon: '🌅', color: '#e88aa0' },
  lunch: { icon: '☀️', color: '#f0a95c' },
  dinner: { icon: '🌆', color: '#9d8fe0' },
  bedtime: { icon: '🌙', color: '#7eb3e8' },
};

// 展开状态跨重渲染保留（重新打开页面回到全部折叠）
const expanded = new Set();

export function intakeKey(item) {
  return `${item.supplement}|${item.slot}`;
}

// handlers: { onToggle(item, nextTaken), onToggleSlot(items, nextTaken) }
export function renderChecklist(container, checklist, intakeMap, handlers) {
  container.innerHTML = '';
  for (const slot of SLOTS) {
    const items = checklist.filter((i) => i.slot === slot);
    if (!items.length) continue;
    const taken = (item) => intakeMap.get(intakeKey(item))?.taken ?? false;
    const allTaken = items.every(taken);
    const takenCount = items.filter(taken).length;
    const isOpen = expanded.has(slot);

    const card = document.createElement('section');
    card.className = `slot-card${isOpen ? ' open' : ''}`;
    card.style.setProperty('--slot-color', SLOT_META[slot].color);

    const head = document.createElement('button');
    head.className = 'slot-head';
    head.innerHTML = `
      <span class="slot-icon"></span>
      <span class="slot-info">
        <span class="slot-name"></span>
        <span class="slot-sub"></span>
      </span>
      <span class="slot-chev">▾</span>
      <span class="slot-check${allTaken ? ' done' : ''}">✓</span>`;
    head.querySelector('.slot-icon').textContent = SLOT_META[slot].icon;
    head.querySelector('.slot-name').textContent = SLOT_LABELS[slot];
    head.querySelector('.slot-sub').textContent =
      `${items.map((i) => i.supplement).join(' + ')}${allTaken ? '' : `（${takenCount}/${items.length}）`}`;
    // 卡头 = 展开/收起；右侧状态圆 = 整段打卡（阻止冒泡）
    head.addEventListener('click', () => {
      if (expanded.has(slot)) expanded.delete(slot);
      else expanded.add(slot);
      card.classList.toggle('open');
      card.querySelector('.slot-items').hidden = !expanded.has(slot);
    });
    head.querySelector('.slot-check').addEventListener('click', (e) => {
      e.stopPropagation();
      handlers.onToggleSlot(items, !allTaken);
    });
    card.appendChild(head);

    const list = document.createElement('div');
    list.className = 'slot-items';
    list.hidden = !isOpen;
    for (const item of items) {
      const isTaken = taken(item);
      const row = document.createElement('button');
      row.className = `intake-row${isTaken ? ' taken' : ''}`;
      row.innerHTML = `
        <span class="dot">✓</span>
        <span class="info"><span class="name"></span><span class="dose"></span></span>`;
      row.querySelector('.name').textContent = item.supplement;
      row.querySelector('.dose').textContent = item.dose;
      row.addEventListener('click', () => handlers.onToggle(item, !isTaken));
      list.appendChild(row);
    }
    card.appendChild(list);
    container.appendChild(card);
  }
}
