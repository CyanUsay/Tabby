// 记录页：连续月历（复用主页两周历的可视化逻辑）+ 当日记录滑卡。
// 月历每格：经期/PMS 荧光带、出血/果冻下划线、排卵日橙圈；点格弹出当日滑卡。
// 滑卡：半屏弹出，上滑全屏、下滑/再点同日/点背景关闭；含补剂、周期、症状、备注。

import { deriveState } from './cycle.js';
import { addDays, diffDays, parseDate, fmt } from './dates.js';
import { severityLabel, severityLevel, severityLevelLabel } from './symptoms.js';
import { SLOTS, SLOT_LABELS } from './protocol.js';

const DOW = ['一', '二', '三', '四', '五', '六', '日'];
const MONTHS_BACK = 11; // 往前回溯多少个月（含当月共 12 个月）
const md = (s) => `${Number(s.slice(5, 7))}/${Number(s.slice(8))}`;
const weekdayName = (s) => '日一二三四五六'[parseDate(s).getDay()];

const EVENT_LABEL = {
  period_start: '亲口宣告：经期开始',
  period_end: '亲口宣告：经期结束',
  not_period: '亲口确认：不是月经',
  pms_start: '进入 PMS',
  jelly: '果冻状分泌物',
  bleed_light: '少量出血',
  bleed_heavy: '经期血量出血',
};

export function initRecords({ db, cfg, getEvents, today }) {
  const monthsEl = document.getElementById('months');
  const sheet = document.getElementById('day-sheet');
  const backdrop = document.getElementById('sheet-backdrop');
  const sheetBody = document.getElementById('day-sheet-body');
  const handle = document.getElementById('sheet-handle');

  let symMap = new Map(); // date -> [症状]（PMS 色带浓度用）
  let selected = null;
  let sheetState = 'closed'; // 'closed' | 'half' | 'full'

  // ---- 月历渲染 ----
  function monthList() {
    const out = [];
    const base = parseDate(today);
    for (let i = MONTHS_BACK; i >= 0; i--) {
      out.push(new Date(base.getFullYear(), base.getMonth() - i, 1));
    }
    return out;
  }

  // 某天是否经期/PMS（荧光带）
  const modeOf = (events, d) => {
    if (d > today) return null;
    const m = deriveState(events, d, cfg).mode;
    return m === 'daily' ? null : m;
  };

  // 同行内相邻同类连成一条：start=左侧无、end=右侧无
  function runEdges(days, i, has) {
    const prev = i % 7 === 0 ? false : has(days[i - 1]);
    const next = i % 7 === 6 || i + 1 >= days.length ? false : has(days[i + 1]);
    return { start: !prev, end: !next };
  }

  function buildMonth(first, events) {
    const y = first.getFullYear();
    const m = first.getMonth();
    const lead = (first.getDay() + 6) % 7; // 周一为首日的前置空格
    const daysInMonth = new Date(y, m + 1, 0).getDate();
    // 网格序列：前置空串 + 当月各日
    const cells = [];
    for (let i = 0; i < lead; i++) cells.push('');
    for (let d = 1; d <= daysInMonth; d++) cells.push(fmt(new Date(y, m, d)));

    const bleedDates = new Set(
      events.filter((e) => ['bleed_light', 'bleed_heavy', 'period_start'].includes(e.event)).map((e) => e.date)
    );
    const jellyDates = new Set(events.filter((e) => e.event === 'jelly').map((e) => e.date));
    const ovuOf = (d) => d && d <= today && deriveState(events, d, cfg).ovulationDate === d;

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

      const mode = modeOf(events, d);
      if (mode) {
        const hl = document.createElement('span');
        const e = runEdges(cells, i, (x) => modeOf(events, x) === mode);
        const sev = mode === 'pms' ? ` sev-${severityLevel(symMap.get(d))}` : '';
        hl.className = `hl ${mode}${sev}${e.start ? ' run-start' : ''}${e.end ? ' run-end' : ''}`;
        cell.appendChild(hl);
      }

      const num = document.createElement('span');
      num.className = 'num';
      num.textContent = String(Number(d.slice(8)));
      cell.appendChild(num);

      if (ovuOf(d)) {
        const ring = document.createElement('span');
        ring.className = 'ovu-mark';
        cell.appendChild(ring);
      }

      const uls = document.createElement('span');
      uls.className = 'uls';
      const spotHas = (x) => x && bleedDates.has(x) && modeOf(events, x) !== 'period';
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
    const from = fmt(monthList()[0]);
    symMap = new Map();
    try {
      const rows = await db.fetchSymptomsRange(from, today);
      for (const r of rows) {
        if (!symMap.has(r.date)) symMap.set(r.date, []);
        symMap.get(r.date).push(r);
      }
    } catch { /* 离线时无浓度，不影响主体 */ }

    monthsEl.innerHTML = '';
    for (const first of monthList()) monthsEl.appendChild(buildMonth(first, events));
    // 滚到当月（最后一个）
    monthsEl.lastElementChild?.scrollIntoView({ block: 'end' });
  }

  // ---- 当日滑卡 ----
  function onTapDay(d) {
    if (selected === d && sheetState !== 'closed') { closeSheet(); return; }
    selected = d;
    markSelected();
    openSheet('half');
    loadDay(d);
  }

  function markSelected() {
    monthsEl.querySelectorAll('.bw-day.sel').forEach((n) => n.classList.remove('sel'));
    if (!selected) return;
    for (const cell of monthsEl.querySelectorAll('.bw-day.rec')) {
      if (cell.querySelector('.num') && cell.__date === selected) cell.classList.add('sel');
    }
  }

  function setSheetState(s) {
    sheetState = s;
    sheet.classList.toggle('full', s === 'full');
    sheet.classList.toggle('half', s === 'half');
    sheet.style.transform = '';
    if (s === 'closed') {
      sheet.hidden = true; backdrop.hidden = true;
      selected = null;
      monthsEl.querySelectorAll('.bw-day.sel').forEach((n) => n.classList.remove('sel'));
    }
  }

  function openSheet(s) {
    sheet.hidden = false; backdrop.hidden = false;
    requestAnimationFrame(() => setSheetState(s));
  }
  function closeSheet() { setSheetState('closed'); }

  backdrop.addEventListener('click', closeSheet);

  // 拖动把手：上滑 full / 下滑 half / 再下滑 close
  (function dragHandle() {
    let startY = 0, dy = 0, dragging = false;
    const onDown = (e) => {
      dragging = true; startY = e.clientY; dy = 0;
      sheet.classList.add('dragging');
      handle.setPointerCapture?.(e.pointerId);
    };
    const onMove = (e) => {
      if (!dragging) return;
      dy = e.clientY - startY;
      const base = sheetState === 'full' ? 0 : sheet.offsetHeight * 0.55;
      sheet.style.transform = `translateY(${Math.max(0, base + dy)}px)`;
    };
    const onUp = () => {
      if (!dragging) return;
      dragging = false;
      sheet.classList.remove('dragging');
      if (dy < -60) setSheetState('full');
      else if (dy > 90) setSheetState(sheetState === 'full' ? 'half' : 'closed');
      else setSheetState(sheetState);
    };
    handle.addEventListener('pointerdown', onDown);
    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onUp);
    handle.addEventListener('pointercancel', onUp);
  })();

  // ---- 当日内容 ----
  async function loadDay(d) {
    const events = getEvents();
    sheetBody.innerHTML = '';
    sheetBody.scrollTop = 0;

    // 标题
    const head = document.createElement('div');
    head.className = 'day-head';
    head.innerHTML = `<span class="day-date"></span><span class="day-dow"></span>`;
    head.querySelector('.day-date').textContent = md(d);
    head.querySelector('.day-dow').textContent = `周${weekdayName(d)}`;
    sheetBody.appendChild(head);

    // 周期状态
    const st = deriveState(events, d, cfg);
    const phaseLabel =
      st.mode === 'period' ? `经期 Day ${st.dayN}`
      : st.mode === 'pms' ? 'PMS 期'
      : st.ovulationDate === d ? '排卵日'
      : st.phase === 'ovulation' ? '排卵期'
      : st.phase === 'luteal' ? '黄体期'
      : '正常';
    sheetBody.appendChild(section('周期', [chipRow([phaseLabel])]));

    // 当天的周期观察/宣告
    const dayEvents = events.filter((e) => e.date === d);
    if (dayEvents.length) {
      sheetBody.appendChild(section('当日周期记录',
        [list(dayEvents.map((e) => EVENT_LABEL[e.event] ?? e.event))]));
    }

    // 异步拉补剂 / 症状 / 备注
    const placeholder = section('补剂 · 症状 · 备注', [hint('读取中…')]);
    sheetBody.appendChild(placeholder);
    let intake = [], symptoms = [], noteRows = [];
    try {
      [intake, symptoms, noteRows] = await Promise.all([
        db.fetchIntakeByDate(d), db.fetchSymptomsByDate(d), db.fetchNote(d),
      ]);
    } catch { /* 离线降级 */ }
    if (selected !== d) return; // 期间又切了日期
    placeholder.remove();

    // 补剂（按时段分组）
    const intakeBlocks = [];
    for (const slot of SLOTS) {
      const names = intake.filter((r) => r.slot === slot).map((r) => r.supplement);
      if (names.length) intakeBlocks.push(`${SLOT_LABELS[slot]}：${names.join('、')}`);
    }
    sheetBody.appendChild(section('补剂打卡',
      intakeBlocks.length ? [list(intakeBlocks)] : [hint('这天没有打卡记录')]));

    // 症状
    const logged = symptoms.filter((s) => s.severity > 0);
    if (logged.length) {
      const level = severityLevelLabel(severityLevel(logged));
      sheetBody.appendChild(section(`症状 · ${level}`,
        [chipRow(logged.map((s) => `${s.symptom} · ${severityLabel(s.severity)}`))]));
    } else {
      sheetBody.appendChild(section('症状', [hint('这天没有记录症状')]));
    }

    // 备注
    const noteWrap = document.createElement('div');
    noteWrap.className = 'day-section';
    noteWrap.appendChild(sectionTitle('备注'));
    const ta = document.createElement('textarea');
    ta.className = 'day-note';
    ta.placeholder = '给这天写点笔记喵…';
    ta.value = noteRows[0]?.body ?? '';
    let timer = null, lastSaved = ta.value;
    const save = async () => {
      if (ta.value === lastSaved) return;
      lastSaved = ta.value;
      try { await db.upsertNote(d, ta.value); } catch { /* 离线下次再存 */ }
    };
    ta.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(save, 700); });
    ta.addEventListener('blur', save);
    noteWrap.appendChild(ta);
    sheetBody.appendChild(noteWrap);
  }

  // ---- 小工具 ----
  function sectionTitle(t) {
    const el = document.createElement('div');
    el.className = 'day-section-title';
    el.textContent = t;
    return el;
  }
  function section(title, children) {
    const wrap = document.createElement('div');
    wrap.className = 'day-section';
    wrap.appendChild(sectionTitle(title));
    children.forEach((c) => wrap.appendChild(c));
    return wrap;
  }
  function chipRow(labels) {
    const row = document.createElement('div');
    row.className = 'day-chips';
    for (const l of labels) {
      const c = document.createElement('span');
      c.className = 'day-chip';
      c.textContent = l;
      row.appendChild(c);
    }
    return row;
  }
  function list(items) {
    const ul = document.createElement('div');
    ul.className = 'day-list';
    for (const it of items) {
      const li = document.createElement('div');
      li.className = 'day-list-row';
      li.textContent = it;
      ul.appendChild(li);
    }
    return ul;
  }
  function hint(t) {
    const el = document.createElement('div');
    el.className = 'day-hint';
    el.textContent = t;
    return el;
  }

  return { render, closeSheet };
}
