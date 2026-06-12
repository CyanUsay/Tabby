// 记录页：连续月历（复用主页两周历的可视化逻辑）+ 当日记录滑卡。
// 月历每格：经期/PMS 荧光带、出血/果冻下划线、排卵日橙圈；点格弹出当日滑卡。
// 滑卡：半屏弹出；上滑进【全屏单页】（只能点左上角 ← 退回月历）；
// 半屏时下滑/再点同日/点背景关闭。内容分块卡片，配色对应各状态。

import { deriveState } from './cycle.js';
import { parseDate, fmt } from './dates.js';
import { severityLabel, severityLevel, severityLevelLabel } from './symptoms.js';
import { SLOTS, SLOT_LABELS } from './protocol.js';
import { SLOT_META } from './checklist.js';

const DOW = ['一', '二', '三', '四', '五', '六', '日'];
const MONTHS_BACK = 11; // 往前回溯月数
const MONTHS_AHEAD = 2; // 往后预留月数
const md = (s) => `${Number(s.slice(5, 7))}/${Number(s.slice(8))}`;
const weekdayName = (s) => '日一二三四五六'[parseDate(s).getDay()];

// 周期事件的展示标签 + 配色（与日历可视化一致）
const EVENT_META = {
  period_start: { label: '亲口宣告 · 经期开始', color: '#d6283b' },
  period_end: { label: '亲口宣告 · 经期结束', color: '#d6283b' },
  not_period: { label: '亲口确认 · 不是月经', color: null },
  pms_start: { label: '进入 PMS', color: '#9d8fe0' },
  jelly: { label: '果冻状分泌物', color: '#7eb3e8' },
  bleed_light: { label: '少量出血', color: '#e88aa0' },
  bleed_heavy: { label: '经期血量出血', color: '#e88aa0' },
};

export function initRecords({ db, cfg, getEvents, today }) {
  const monthsEl = document.getElementById('months');
  const sheet = document.getElementById('day-sheet');
  const backdrop = document.getElementById('sheet-backdrop');
  const sheetBody = document.getElementById('day-sheet-body');
  const sheetTitle = document.getElementById('sheet-title');
  const handle = document.getElementById('sheet-handle');
  const backBtn = document.getElementById('sheet-back');

  let symMap = new Map(); // date -> [症状]（PMS 色带浓度用）
  let selected = null;
  let sheetState = 'closed'; // 'closed' | 'half' | 'full'

  // ---- 月历渲染 ----
  function monthList() {
    const out = [];
    const base = parseDate(today);
    for (let i = MONTHS_BACK; i >= -MONTHS_AHEAD; i--) {
      out.push(new Date(base.getFullYear(), base.getMonth() - i, 1));
    }
    return out;
  }

  function runEdges(days, i, has) {
    const prev = i % 7 === 0 ? false : has(days[i - 1]);
    const next = i % 7 === 6 || i + 1 >= days.length ? false : has(days[i + 1]);
    return { start: !prev, end: !next };
  }

  function buildMonth(first, events, stOf) {
    const y = first.getFullYear();
    const m = first.getMonth();
    const lead = (first.getDay() + 6) % 7; // 周一为首日的前置空格
    const daysInMonth = new Date(y, m + 1, 0).getDate();
    const cells = [];
    for (let i = 0; i < lead; i++) cells.push('');
    for (let d = 1; d <= daysInMonth; d++) cells.push(fmt(new Date(y, m, d)));

    const bleedDates = new Set(
      events.filter((e) => ['bleed_light', 'bleed_heavy', 'period_start'].includes(e.event)).map((e) => e.date)
    );
    const jellyDates = new Set(events.filter((e) => e.event === 'jelly').map((e) => e.date));
    const modeOf = (d) => {
      if (!d || d > today) return null;
      const md = stOf(d).mode;
      return md === 'daily' ? null : md;
    };

    const wrap = document.createElement('div');
    wrap.className = 'month';
    const title = document.createElement('div');
    title.className = 'month-title';
    title.textContent = `${y} 年 ${m + 1} 月`;
    wrap.appendChild(title);

    const grid = document.createElement('div');
    grid.className = 'biweek';
    for (const dn of DOW) {
      const c = document.createElement('div');
      c.className = 'bw-dow';
      c.textContent = dn;
      grid.appendChild(c);
    }

    cells.forEach((d, i) => {
      const cell = document.createElement('div');
      if (!d) { cell.className = 'bw-day empty'; grid.appendChild(cell); return; }
      cell.className = 'bw-day rec'
        + (d === today ? ' today' : '') + (d > today ? ' future' : '')
        + (d === selected ? ' sel' : '');
      cell.__date = d;

      const mode = modeOf(d);
      if (mode) {
        const hl = document.createElement('span');
        const e = runEdges(cells, i, (x) => modeOf(x) === mode);
        const sev = mode === 'pms' ? ` sev-${severityLevel(symMap.get(d))}` : '';
        hl.className = `hl ${mode}${sev}${e.start ? ' run-start' : ''}${e.end ? ' run-end' : ''}`;
        cell.appendChild(hl);
      }

      const num = document.createElement('span');
      num.className = 'num';
      num.textContent = String(Number(d.slice(8)));
      cell.appendChild(num);

      if (d <= today && stOf(d).ovulationDate === d) {
        const ring = document.createElement('span');
        ring.className = 'ovu-mark';
        cell.appendChild(ring);
      }

      const uls = document.createElement('span');
      uls.className = 'uls';
      const spotHas = (x) => x && bleedDates.has(x) && modeOf(x) !== 'period';
      const marks = [
        ...(spotHas(d) ? [['bleed', spotHas]] : []),
        ...(jellyDates.has(d) ? [['jelly', (x) => jellyDates.has(x)]] : []),
      ];
      for (const [cls, has] of marks) {
        const ul = document.createElement('i');
        const e = runEdges(cells, i, has);
        ul.className = `ul ${cls}${e.start ? ' run-start' : ''}${e.end ? ' run-end' : ''}`;
        uls.appendChild(ul);
      }
      cell.appendChild(uls);

      if (d <= today) cell.addEventListener('click', () => onTapDay(d));
      grid.appendChild(cell);
    });

    wrap.appendChild(grid);
    return wrap;
  }

  async function render() {
    const events = getEvents();
    const list = monthList();
    const from = fmt(list[0]);
    // 每日状态推算缓存（runEdges 会重复探查邻格，没缓存会算三遍）
    const stCache = new Map();
    const stOf = (d) => {
      if (!stCache.has(d)) stCache.set(d, deriveState(events, d, cfg));
      return stCache.get(d);
    };

    symMap = new Map();
    try {
      const rows = await db.fetchSymptomsRange(from, today);
      for (const r of rows) {
        if (!symMap.has(r.date)) symMap.set(r.date, []);
        symMap.get(r.date).push(r);
      }
    } catch { /* 离线时无浓度，不影响主体 */ }

    monthsEl.innerHTML = '';
    for (const first of list) monthsEl.appendChild(buildMonth(first, events, stOf));
    scrollToCurrentMonthEnd();
  }

  // 打开记录页：自动滚到"刚好显示完当月"的位置（当月末尾贴着 Tab 栏上沿）
  function scrollToCurrentMonthEnd() {
    requestAnimationFrame(() => {
      const cur = monthsEl.children[MONTHS_BACK];
      if (!cur) return;
      const bottomGap = 70; // Tab 栏视觉高度 + 余量
      const y = cur.getBoundingClientRect().bottom + window.scrollY - window.innerHeight + bottomGap;
      window.scrollTo(0, Math.max(0, y));
    });
  }

  // ---- 滑卡开合 ----
  function onTapDay(d) {
    if (selected === d && sheetState !== 'closed') { closeSheet(); return; }
    selected = d;
    monthsEl.querySelectorAll('.bw-day.sel').forEach((n) => n.classList.remove('sel'));
    for (const cell of monthsEl.querySelectorAll('.bw-day.rec')) {
      if (cell.__date === d) cell.classList.add('sel');
    }
    openSheet('half');
    loadDay(d);
  }

  // 滑卡打开时锁住底下页面滚动（iOS 经典 body-fixed 方案，防误触月历）
  let scrollLockY = 0;
  function lockScroll() {
    scrollLockY = window.scrollY;
    document.body.classList.add('no-scroll');
    document.body.style.top = `-${scrollLockY}px`;
  }
  function unlockScroll() {
    document.body.classList.remove('no-scroll');
    document.body.style.top = '';
    window.scrollTo(0, scrollLockY);
  }

  function setSheetState(s) {
    sheetState = s;
    sheet.classList.toggle('full', s === 'full');
    sheet.classList.toggle('half', s === 'half');
    sheet.style.transform = '';
    if (s === 'closed') {
      sheet.hidden = true; backdrop.hidden = true;
      unlockScroll();
      selected = null;
      monthsEl.querySelectorAll('.bw-day.sel').forEach((n) => n.classList.remove('sel'));
    }
  }

  function openSheet(s) {
    if (sheet.hidden) lockScroll();
    sheet.hidden = false; backdrop.hidden = false;
    requestAnimationFrame(() => setSheetState(s));
  }
  function closeSheet() { setSheetState('closed'); }

  backdrop.addEventListener('click', closeSheet);
  backBtn.addEventListener('click', closeSheet); // 全屏单页：← 退回月历

  // 拖动把手（仅半屏可拖）：上滑进全屏单页 / 下滑关闭
  (function dragHandle() {
    let startY = 0, dy = 0, dragging = false;
    handle.addEventListener('pointerdown', (e) => {
      if (sheetState !== 'half') return;
      dragging = true; startY = e.clientY; dy = 0;
      sheet.classList.add('dragging');
      handle.setPointerCapture?.(e.pointerId);
    });
    handle.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      dy = e.clientY - startY;
      const base = sheet.offsetHeight * 0.58;
      sheet.style.transform = `translateY(${Math.max(0, base + dy)}px)`;
    });
    const onUp = () => {
      if (!dragging) return;
      dragging = false;
      sheet.classList.remove('dragging');
      if (dy < -60) setSheetState('full');
      else if (dy > 90) setSheetState('closed');
      else setSheetState('half');
    };
    handle.addEventListener('pointerup', onUp);
    handle.addEventListener('pointercancel', onUp);
  })();

  // ---- 当日内容（分块卡片，参考主页样式） ----
  function phaseChipOf(st, d) {
    if (st.mode === 'period') return { text: `🩸 经期 Day ${st.dayN}`, color: '#d6283b' };
    if (st.mode === 'pms') return { text: '💜 PMS 期', color: '#9d8fe0' };
    if (st.ovulationDate === d) return { text: '🔆 排卵日', color: '#f0a95c' };
    if (st.phase === 'ovulation') return { text: '🔅 排卵期', color: '#f0a95c' };
    if (st.phase === 'luteal') return { text: '💜 黄体期', color: '#9d8fe0' };
    return { text: '正常', color: null };
  }

  async function loadDay(d) {
    const events = getEvents();
    sheetTitle.textContent = `${md(d)} · 周${weekdayName(d)}`;
    sheetBody.innerHTML = '';
    sheetBody.scrollTop = 0;

    // 周期状态 + 当日周期记录（合一张卡）
    const st = deriveState(events, d, cfg);
    const chip = phaseChipOf(st, d);
    const cycleCard = card('周期');
    cycleCard.appendChild(tintChip(chip.text, chip.color, true));
    const dayEvents = events.filter((e) => e.date === d);
    if (dayEvents.length) {
      const row = document.createElement('div');
      row.className = 'day-chips';
      for (const e of dayEvents) {
        const meta = EVENT_META[e.event] ?? { label: e.event, color: null };
        row.appendChild(tintChip(meta.label, meta.color));
      }
      cycleCard.appendChild(row);
    }
    sheetBody.appendChild(cycleCard);

    // 异步拉补剂 / 症状 / 备注
    const loading = card('');
    loading.appendChild(hint('读取中…'));
    sheetBody.appendChild(loading);
    let intake = [], symptoms = [], noteRows = [];
    try {
      [intake, symptoms, noteRows] = await Promise.all([
        db.fetchIntakeByDate(d), db.fetchSymptomsByDate(d), db.fetchNote(d),
      ]);
    } catch { /* 离线降级 */ }
    if (selected !== d) return; // 期间又切了日期
    loading.remove();

    // 补剂打卡：按时段分行，时段图标+色点（与今日安排一致）
    const intakeCard = card('补剂打卡');
    let any = false;
    for (const slot of SLOTS) {
      const names = intake.filter((r) => r.slot === slot).map((r) => r.supplement);
      if (!names.length) continue;
      any = true;
      const row = document.createElement('div');
      row.className = 'day-slot';
      row.style.setProperty('--slot-color', SLOT_META[slot].color);
      row.innerHTML = `<span class="day-slot-name"></span><span class="day-slot-items"></span>`;
      row.querySelector('.day-slot-name').textContent = SLOT_LABELS[slot];
      row.querySelector('.day-slot-items').textContent = names.join(' + ');
      intakeCard.appendChild(row);
    }
    if (!any) intakeCard.appendChild(hint('这天没有打卡记录'));
    sheetBody.appendChild(intakeCard);

    // 症状：紫色系 chip（程度色阶与症状卡一致）
    const logged = symptoms.filter((s) => s.severity > 0);
    const symCard = card(logged.length ? `症状 · ${severityLevelLabel(severityLevel(logged))}` : '症状');
    if (logged.length) {
      const row = document.createElement('div');
      row.className = 'day-chips';
      for (const s of logged) {
        const c = document.createElement('span');
        c.className = `day-chip day-sym sev-${s.severity}`;
        c.textContent = `${s.symptom} · ${severityLabel(s.severity)}`;
        row.appendChild(c);
      }
      symCard.appendChild(row);
    } else {
      symCard.appendChild(hint('这天没有记录症状'));
    }
    sheetBody.appendChild(symCard);

    // 备注：查看态（正文+编辑）⇄ 编辑态（输入框+确认）
    sheetBody.appendChild(noteCard(d, noteRows[0]?.body ?? ''));
  }

  function noteCard(d, initial) {
    const wrap = card('备注');
    let body = initial;
    let editing = !body; // 还没写过 → 直接进编辑态

    const rebuild = () => {
      wrap.querySelectorAll('.day-note, .note-view, .note-actions').forEach((n) => n.remove());
      if (editing) {
        const ta = document.createElement('textarea');
        ta.className = 'day-note';
        ta.placeholder = '给这天写点笔记喵…';
        ta.value = body;
        const actions = document.createElement('div');
        actions.className = 'note-actions';
        const ok = document.createElement('button');
        ok.className = 'btn primary';
        ok.textContent = '确认';
        ok.hidden = !ta.value.trim(); // 写了字才出现
        ta.addEventListener('input', () => { ok.hidden = !ta.value.trim(); });
        ok.addEventListener('click', async () => {
          ok.disabled = true;
          try {
            await db.upsertNote(d, ta.value.trim());
            body = ta.value.trim();
            editing = !body; // 存了内容 → 切回查看态
            rebuild();
          } catch {
            ok.disabled = false;
            ok.textContent = '存不上…再试';
          }
        });
        actions.appendChild(ok);
        wrap.append(ta, actions);
      } else {
        const view = document.createElement('div');
        view.className = 'note-view';
        view.textContent = body;
        const actions = document.createElement('div');
        actions.className = 'note-actions';
        const edit = document.createElement('button');
        edit.className = 'btn ghost';
        edit.textContent = '编辑';
        edit.addEventListener('click', () => { editing = true; rebuild(); });
        actions.appendChild(edit);
        wrap.append(view, actions);
      }
    };
    rebuild();
    return wrap;
  }

  // ---- 小工具 ----
  function card(title) {
    const el = document.createElement('section');
    el.className = 'card day-card';
    if (title) {
      const t = document.createElement('div');
      t.className = 'day-section-title';
      t.textContent = title;
      el.appendChild(t);
    }
    return el;
  }
  function tintChip(text, color, big = false) {
    const c = document.createElement('span');
    c.className = `day-chip${big ? ' big' : ''}`;
    if (color) {
      c.style.background = `color-mix(in srgb, ${color} 16%, transparent)`;
      c.style.color = color;
      c.style.borderColor = 'transparent';
    }
    c.textContent = text;
    return c;
  }
  function hint(t) {
    const el = document.createElement('div');
    el.className = 'day-hint';
    el.textContent = t;
    return el;
  }

  return { render, closeSheet };
}
