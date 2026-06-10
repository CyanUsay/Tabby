// 入口：主题 → SW 注册 → 拉数据 → 推导 mode → 渲染各区 → 装配聊天流程。
// Supabase 拉取失败时降级为只读（本地清单仍可见）。

import { cycleConfig } from './config.js';
import { appToday } from './dates.js';
import { getChecklist } from './protocol.js';
import { deriveMode } from './cycle.js';
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
  modeInfo: { mode: 'daily', dayN: null, nextPeriodDate: null },
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

/* ---------- 渲染 ---------- */
function renderHero() {
  const h = new Date().getHours();
  const [greeting, emoji] =
    h < 5 || h >= 23 ? ['夜深了', '🌙']
    : h < 11 ? ['早上好', '☀️']
    : h < 14 ? ['中午好', '🍱']
    : h < 18 ? ['下午好', '🫖']
    : ['晚上好', '🌆'];
  $('greeting').textContent = `${greeting} ${emoji}`;
  const DOW = ['日', '一', '二', '三', '四', '五', '六'];
  const [, m, d] = state.today.split('-').map(Number);
  $('date-line').textContent =
    `${m}月${d}日 星期${DOW[new Date().getDay()]} · 今天也照顾好自己`;
}

const RING_C = 2 * Math.PI * 52; // r=52，与 SVG 一致

function renderProgress() {
  const total = state.checklist.length;
  const taken = state.checklist.filter((i) => state.intakeMap.get(intakeKey(i))?.taken).length;
  const frac = total ? taken / total : 0;
  $('ring-fill').style.strokeDasharray = RING_C;
  $('ring-fill').style.strokeDashoffset = RING_C * (1 - frac);
  $('ring-pct').textContent = `${Math.round(frac * 100)}%`;
  $('ring-sub').textContent = `${taken}/${total} 已完成`;

  const { mode, dayN, daysSinceEnd, ovulating } = state.modeInfo;
  $('stat-mode').textContent =
    mode === 'period' ? `经期 Day ${dayN}` : mode === 'pms' ? 'PMS 期' : '日常';
  $('stat-since').textContent = daysSinceEnd === null ? '—' : `${daysSinceEnd} 天`;
  $('stat-ovulation').textContent = ovulating ? '可能进行中' : '—';
  $('stat-symptoms').textContent = `${state.todaySymptoms.filter((s) => s.severity > 0).length} 项`;
}

function renderList() {
  renderChecklist($('checklist'), state.checklist, state.intakeMap, {
    onToggle: onToggleIntake,
    onToggleSlot,
  });
}

function renderAll() {
  renderHero();
  renderProgress();
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
  state.modeInfo = deriveMode(state.cycleEvents, state.today, cycleConfig);
  state.checklist = getChecklist(state.modeInfo.mode);
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
    renderProgress();
    console.error(e);
  }
}

async function onToggleIntake(item, nextTaken) {
  if (state.degraded) return;
  const key = intakeKey(item);
  const prev = [[key, state.intakeMap.get(key)]];
  state.intakeMap.set(key, intakeRowOf(item, nextTaken)); // 乐观更新
  renderList();
  renderProgress();
  await persistIntake([state.intakeMap.get(key)], prev);
}

async function onToggleSlot(items, nextTaken) {
  if (state.degraded) return;
  const prev = items.map((i) => [intakeKey(i), state.intakeMap.get(intakeKey(i))]);
  const rows = items.map((i) => intakeRowOf(i, nextTaken));
  rows.forEach((r, idx) => state.intakeMap.set(intakeKey(items[idx]), r));
  renderList();
  renderProgress();
  await persistIntake(rows, prev);
}

async function onLogSymptom(symptom, severity, isCustom) {
  if (state.degraded) return;
  await db.upsertSymptoms([
    { date: state.today, symptom, severity, is_custom: isCustom },
  ]);
  if (isCustom) await db.bumpSymptomCatalog(symptom).catch(() => {});
  state.todaySymptoms = await db.fetchTodaySymptoms(state.today);
  renderAll();
}

// 预览卡确认后的统一落库（chat.js 回调）
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
    // mode 可能变了 → 重拉事件、重算清单
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
}

/* ---------- 启动 ---------- */
async function boot() {
  recomputeMode(); // 先用空事件渲染本地清单（离线也能看）
  renderAll();
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
