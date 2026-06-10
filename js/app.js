// 入口：主题 → SW 注册 → 拉数据 → 推算状态 → 渲染各区 → 装配交互。
// Supabase 拉取失败时降级为只读（本地清单仍可见）。

import { cycleConfig, PMS_MARKER_SYMPTOMS } from './config.js';
import { appToday, weekOf, addDays } from './dates.js';
import { getChecklist } from './protocol.js';
import { deriveState } from './cycle.js';
import * as realDb from './db.js';
import { parseUtterance } from './ai.js';
import { renderChecklist, intakeKey } from './checklist.js';
import { renderSymptoms } from './symptoms.js';
import { initChat } from './chat.js';
import { makeMockDb, mockParse } from './mock.js';

const MOCK = new URLSearchParams(location.search).has('mock');
const db = MOCK ? makeMockDb() : realDb;
const parse = MOCK ? mockParse : parseUtterance;

const $ = (id) => document.getElementById(id);

const state = {
  today: appToday(),
  modeInfo: { mode: 'daily', dayN: null, daysSinceEnd: null, daysSinceOvulation: null },
  checklist: [],
  intakeMap: new Map(),
  todaySymptoms: [],
  fixedSymptoms: [],
  cycleEvents: [],
  degraded: false,
};

/* ---------- 主题 ---------- */
const THEME_KEY = 'tabby-theme';
const THEME_COLORS = { light: '#fadce9', dark: '#16151b' };

function currentTheme() {
  return (
    localStorage.getItem(THEME_KEY) ||
    (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
  );
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  document.querySelector('meta[name="theme-color"]').content = THEME_COLORS[theme];
  $('theme-toggle').textContent = theme === 'dark' ? '🌙' : '☀️';
}

$('theme-toggle').addEventListener('click', () => {
  const next = currentTheme() === 'dark' ? 'light' : 'dark';
  localStorage.setItem(THEME_KEY, next);
  applyTheme(next);
});
applyTheme(currentTheme());

/* ---------- PWA ---------- */
if ('serviceWorker' in navigator && !MOCK) {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}

const isStandalone =
  navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;
if (!isStandalone && !localStorage.getItem('tabby-install-hinted')) {
  $('install-hint').classList.remove('hidden');
  localStorage.setItem('tabby-install-hinted', '1');
  setTimeout(() => $('install-hint').classList.add('hidden'), 15000);
}

/* ---------- 双周日历 ---------- */
function renderCalendar() {
  const el = $('biweek');
  el.innerHTML = '';
  const DOW = ['一', '二', '三', '四', '五', '六', '日'];
  for (const d of DOW) {
    const c = document.createElement('div');
    c.className = 'bw-dow';
    c.textContent = d;
    el.appendChild(c);
  }

  const days = [...weekOf(addDays(state.today, -7)), ...weekOf(state.today)];
  const ev = state.cycleEvents;
  const bleedDates = new Set(
    ev.filter((e) => ['bleed_light', 'bleed_heavy', 'period_start'].includes(e.event)).map((e) => e.date)
  );
  const jellyDates = new Set(ev.filter((e) => e.event === 'jelly').map((e) => e.date));
  // 每天的状态条颜色（period/pms/null），未来日期不画
  const barOf = (d) =>
    d > state.today ? null : (() => {
      const m = deriveState(ev, d, cycleConfig).mode;
      return m === 'daily' ? null : m;
    })();

  days.forEach((d, i) => {
    const bar = barOf(d);
    const prevBar = i % 7 === 0 ? null : barOf(days[i - 1]); // 跨行不连
    const nextBar = i % 7 === 6 ? null : i + 1 < days.length ? barOf(days[i + 1]) : null;
    const cell = document.createElement('div');
    cell.className =
      'bw-day' + (d === state.today ? ' today' : '') + (d > state.today ? ' future' : '');
    const num = document.createElement('span');
    num.className = 'num';
    num.textContent = String(Number(d.slice(8)));
    cell.appendChild(num);
    const barEl = document.createElement('span');
    barEl.className = 'bar';
    if (bar) {
      barEl.classList.add(bar);
      if (prevBar !== bar) barEl.classList.add('run-start');
      if (nextBar !== bar) barEl.classList.add('run-end');
    }
    cell.appendChild(barEl);
    const marks = document.createElement('span');
    marks.className = 'marks';
    if (bleedDates.has(d)) {
      const m = document.createElement('i');
      m.className = 'mk bleed';
      marks.appendChild(m);
    }
    if (jellyDates.has(d)) {
      const m = document.createElement('i');
      m.className = 'mk jelly';
      marks.appendChild(m);
    }
    cell.appendChild(marks);
    el.appendChild(cell);
  });
}

/* ---------- 统计 + 打卡按钮状态 ---------- */
function renderStats() {
  const { mode, dayN, daysSinceEnd, daysSinceOvulation } = state.modeInfo;
  $('stat-mode').textContent =
    mode === 'period' ? `经期 Day ${dayN}` : mode === 'pms' ? 'PMS 期' : '日常';
  $('stat-since').textContent = daysSinceEnd === null ? '—' : `${daysSinceEnd} 天`;
  $('stat-ovulation').textContent =
    daysSinceOvulation === null ? '—' : daysSinceOvulation === 0 ? '推测今天' : `${daysSinceOvulation} 天`;
  $('stat-symptoms').textContent = `${state.todaySymptoms.filter((s) => s.severity > 0).length} 项`;

  const total = state.checklist.length;
  const taken = state.checklist.filter((i) => state.intakeMap.get(intakeKey(i))?.taken).length;
  const allDone = total > 0 && taken === total;
  $('done-btn').classList.toggle('done', allDone);
  $('done-label').textContent = allDone ? '完成喵 ✓' : '长按打卡';
  $('done-sub').textContent = allDone ? `今日 ${taken}/${total}` : `一键记录今天正常完成（${taken}/${total}）`;
}

function renderSymptomsCount() {
  const n = state.todaySymptoms.filter((s) => s.severity > 0).length;
  $('symptoms-count').textContent = n > 0 ? `${n} 项` : '';
}

function renderList() {
  renderChecklist($('checklist'), state.checklist, state.intakeMap, {
    onToggle: onToggleIntake,
    onToggleSlot,
  });
}

function renderAll() {
  renderCalendar();
  renderStats();
  renderSymptomsCount();
  renderList();
  renderSymptoms(
    {
      chipsEl: $('symptom-chips'),
      pickerEl: $('severity-picker'),
      input: $('custom-symptom-input'),
      addBtn: $('custom-symptom-add'),
    },
    state.fixedSymptoms,
    state.todaySymptoms,
    onLogSymptom
  );
}

function recomputeMode() {
  state.modeInfo = deriveState(state.cycleEvents, state.today, cycleConfig);
  state.checklist = getChecklist(state.modeInfo.mode);
}

// 周期事件确认后，用一句话反馈推算结果（回溯效果在这里变得可见）
function cycleFeedback(event) {
  const { mode, dayN, periodStart, daysSinceOvulation, spottingToday } = state.modeInfo;
  const md = (s) => `${Number(s.slice(5, 7))}/${Number(s.slice(8))}`;
  if (event === 'bleed_heavy' || event === 'period_start') {
    if (mode === 'period') {
      return dayN > 1
        ? `记好啦喵！主人的经期从 ${md(periodStart)} 起算（前几天的出血并进来了），今天 Day ${dayN} (=^･ω･^=)`
        : '记好啦喵！经期 Day 1，补剂清单切换好了，主人多保重 (=^･ω･^=)';
    }
  }
  if (event === 'bleed_light') {
    return mode === 'period'
      ? `记好啦喵！这段出血并入经期，今天 Day ${dayN} (=^･ω･^=)`
      : spottingToday
        ? '记好啦喵～暂记为不正出血；要是之后血量上来，Tabby 会自动回溯并入经期的喵 ฅ(•ㅅ•)ฅ'
        : '记好啦喵 ✓';
  }
  if (event === 'jelly') {
    return daysSinceOvulation === 0
      ? '记好啦喵～排卵日暂记今天，连续报告会自动顺延到最后一天喵 ฅ^•ﻌ•^ฅ'
      : '记好啦喵 ✓';
  }
  if (event === 'pms_start') return '记好啦喵！已进入 PMS 模式，B6 和镁都加量了，主人请多照顾自己喵 (=ↀωↀ=)';
  if (event === 'period_end') return '记好啦喵！经期结束，清单回到日常，主人辛苦了喵 ฅ^•ﻌ•^ฅ';
  return '记好啦喵 ✓ ฅ^•ﻌ•^ฅ';
}

/* ---------- 写库操作 ---------- */
function intakeRowOf(item, taken) {
  return {
    date: state.today,
    supplement: item.supplement,
    slot: item.slot,
    dose: item.dose,
    taken,
    mode: state.modeInfo.mode,
  };
}

async function persistIntake(rows, prev) {
  try {
    await db.upsertIntake(rows);
  } catch (e) {
    for (const [key, row] of prev) {
      if (row) state.intakeMap.set(key, row);
      else state.intakeMap.delete(key);
    }
    renderList();
    renderStats();
    console.error(e);
  }
}

async function onToggleIntake(item, nextTaken) {
  if (state.degraded) return;
  const key = intakeKey(item);
  const prev = [[key, state.intakeMap.get(key)]];
  state.intakeMap.set(key, intakeRowOf(item, nextTaken)); // 乐观更新
  renderList();
  renderStats();
  await persistIntake([state.intakeMap.get(key)], prev);
}

async function onToggleSlot(items, nextTaken) {
  if (state.degraded) return;
  const prev = items.map((i) => [intakeKey(i), state.intakeMap.get(intakeKey(i))]);
  const rows = items.map((i) => intakeRowOf(i, nextTaken));
  rows.forEach((r, idx) => state.intakeMap.set(intakeKey(items[idx]), r));
  renderList();
  renderStats();
  await persistIntake(rows, prev);
}

async function onLogSymptom(symptom, severity, isCustom) {
  if (state.degraded) return;
  await db.upsertSymptoms([
    { date: state.today, symptom, severity, is_custom: isCustom },
  ]);
  if (isCustom && severity > 0) await db.bumpSymptomCatalog(symptom).catch(() => {});
  state.todaySymptoms = await db.fetchTodaySymptoms(state.today);
  renderAll();
  maybePromptPms();
}

/* ---------- 长按打卡：一键全部完成 ---------- */
function initDoneButton() {
  const btn = $('done-btn');
  const HOLD_MS = 700;
  let timer = null;

  const cancel = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    btn.classList.remove('pressing');
  };

  btn.addEventListener('pointerdown', (e) => {
    if (state.degraded) return;
    e.preventDefault();
    btn.classList.add('pressing');
    timer = setTimeout(async () => {
      cancel();
      await markAllDone();
      celebrate();
    }, HOLD_MS);
  });
  btn.addEventListener('pointerup', cancel);
  btn.addEventListener('pointercancel', cancel);
  btn.addEventListener('pointerleave', cancel);
  btn.addEventListener('contextmenu', (e) => e.preventDefault()); // 防 iOS 长按弹菜单
}

async function markAllDone() {
  const items = state.checklist;
  const prev = items.map((i) => [intakeKey(i), state.intakeMap.get(intakeKey(i))]);
  const rows = items.map((i) => intakeRowOf(i, true));
  rows.forEach((r, idx) => state.intakeMap.set(intakeKey(items[idx]), r));
  renderList();
  renderStats();
  await persistIntake(rows, prev);
}

function celebrate() {
  const layer = document.createElement('div');
  layer.className = 'celebrate';
  const cat = document.createElement('img');
  cat.src = './icons/icon-192.png';
  cat.alt = '';
  const say = document.createElement('div');
  say.className = 'say';
  say.textContent = '太棒了喵！ฅ^•ﻌ•^ฅ';
  layer.append(cat, say);
  layer.addEventListener('click', () => layer.remove());
  document.body.appendChild(layer);
  setTimeout(() => layer.remove(), 2000);
}

/* ---------- PMS 症状询问 ---------- */
// 记录到典型 PMS 症状且当前是日常模式 → 询问是否进入 PMS（确认才切，不自动）
function maybePromptPms() {
  if (state.degraded || state.modeInfo.mode !== 'daily') return;
  const hit = state.todaySymptoms.some(
    (s) => s.severity > 0 && PMS_MARKER_SYMPTOMS.includes(s.symptom)
  );
  if (!hit) return;
  if (localStorage.getItem('tabby-pms-dismissed') === state.today) return;
  if (document.getElementById('pms-ask')) return;

  const card = document.createElement('div');
  card.id = 'pms-ask';
  card.className = 'preview-card';
  const text = document.createElement('div');
  text.className = 'pms-ask-text';
  text.textContent =
    '主人记到了典型的 PMS 症状喵，要进入 PMS 模式吗？（B6、镁会加量；之后来例假会自动切到经期模式喵）ฅ(•ㅅ•)ฅ';
  const actions = document.createElement('div');
  actions.className = 'preview-actions';
  const later = document.createElement('button');
  later.className = 'btn ghost';
  later.textContent = '先不喵';
  later.addEventListener('click', () => {
    localStorage.setItem('tabby-pms-dismissed', state.today);
    card.remove();
  });
  const yes = document.createElement('button');
  yes.className = 'btn primary';
  yes.textContent = '进入 PMS 模式';
  yes.addEventListener('click', async () => {
    yes.disabled = true;
    try {
      await db.insertCycleEvent({ event: 'pms_start', date: state.today });
      state.cycleEvents = await db.fetchCycleEvents();
      recomputeMode();
      renderAll();
      card.remove();
      const bubble = document.createElement('div');
      bubble.className = 'bubble tabby';
      bubble.textContent = '已进入 PMS 模式喵！清单加上 B6、镁加到 300mg，主人要好好照顾自己 (=ↀωↀ=)';
      const log = $('chat-log');
      log.appendChild(bubble);
      log.scrollTop = log.scrollHeight;
    } catch (e) {
      yes.disabled = false;
      console.error(e);
    }
  });
  actions.append(later, yes);
  card.append(text, actions);
  const log = $('chat-log');
  log.appendChild(card);
  log.scrollTop = log.scrollHeight;
}

/* ---------- 预览卡确认后的统一落库（chat.js 回调） ---------- */
async function commitDraft(draft) {
  if (draft.intake.length) {
    await db.upsertIntake(
      draft.intake.map((i) => ({ ...i, date: state.today, mode: state.modeInfo.mode }))
    );
  }
  if (draft.symptoms.length) {
    await db.upsertSymptoms(draft.symptoms.map((s) => ({ ...s, date: state.today })));
    for (const s of draft.symptoms.filter((x) => x.is_custom)) {
      await db.bumpSymptomCatalog(s.symptom).catch(() => {});
    }
  }
  if (draft.cycle) {
    await db.insertCycleEvent(draft.cycle);
    // 状态可能变了 → 重拉事件、重算清单
    state.cycleEvents = await db.fetchCycleEvents();
    recomputeMode();
  }
  const [intakeRows, symptomRows] = await Promise.all([
    db.fetchTodayIntake(state.today),
    db.fetchTodaySymptoms(state.today),
  ]);
  state.intakeMap = new Map(intakeRows.map((r) => [intakeKey(r), r]));
  state.todaySymptoms = symptomRows;
  renderAll();
  maybePromptPms();
  return draft.cycle ? cycleFeedback(draft.cycle.event) : null;
}

/* ---------- 症状卡收起/展开 ---------- */
function initSymptomsToggle() {
  const card = document.querySelector('.symptoms-card');
  $('symptoms-toggle').addEventListener('click', () => {
    const body = $('symptoms-body');
    const open = body.hidden;
    body.hidden = !open;
    card.classList.toggle('open', open);
  });
}

/* ---------- 启动 ---------- */
async function boot() {
  recomputeMode(); // 先用空事件渲染本地清单（离线也能看）
  renderAll();
  initDoneButton();
  initSymptomsToggle();
  try {
    const [events, fixed, intakeRows, symptomRows] = await Promise.all([
      db.fetchCycleEvents(),
      db.fetchFixedSymptoms(),
      db.fetchTodayIntake(state.today),
      db.fetchTodaySymptoms(state.today),
    ]);
    state.cycleEvents = events;
    state.fixedSymptoms = fixed.map((r) => r.name);
    state.intakeMap = new Map(intakeRows.map((r) => [intakeKey(r), r]));
    state.todaySymptoms = symptomRows;
    recomputeMode();
  } catch (e) {
    state.degraded = true;
    $('offline-banner').classList.remove('hidden');
    console.error(e);
  }
  renderAll();
  maybePromptPms();

  initChat({
    logEl: $('chat-log'),
    input: $('chat-input'),
    sendBtn: $('chat-send'),
    getContext: () => ({
      date: state.today,
      mode: state.modeInfo.mode,
      checklist: state.checklist,
      fixedSymptoms: state.fixedSymptoms,
    }),
    parse,
    onCommit: commitDraft,
  });
}

boot();
