// 入口：主题 → SW 注册 → 拉数据 → 推导 mode → 渲染各区 → 装配聊天流程。
// Supabase 拉取失败时降级为只读（本地清单仍可见）。

import { cycleConfig } from './config.js';
import { appToday, weekOf } from './dates.js';
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
const THEME_COLORS = { light: '#e3e8ee', dark: '#16161a' };

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
function renderWeekStrip() {
  const el = $('week-strip');
  el.innerHTML = '';
  const DOW = ['一', '二', '三', '四', '五', '六', '日'];
  weekOf(state.today).forEach((dateStr, i) => {
    const day = document.createElement('div');
    day.className = `week-day${dateStr === state.today ? ' today' : ''}`;
    day.innerHTML = `<span class="dow"></span><span class="dom"></span>`;
    day.querySelector('.dow').textContent = DOW[i];
    day.querySelector('.dom').textContent = String(Number(dateStr.slice(8)));
    el.appendChild(day);
  });
}

function renderModeBadge() {
  const { mode, dayN } = state.modeInfo;
  const badge = $('mode-badge');
  badge.className = `mode-badge ${mode}`;
  badge.textContent =
    mode === 'period' ? `🌙 经期 Day ${dayN}` : mode === 'pms' ? '🌸 PMS' : '☁️ 日常';
}

function renderHero() {
  const h = new Date().getHours();
  const greeting =
    h < 5 || h >= 23 ? '夜深了，照顾好自己'
    : h < 11 ? '早上好呀'
    : h < 14 ? '中午好呀'
    : h < 18 ? '下午好呀'
    : '晚上好呀';
  $('greeting').textContent = greeting;
  const DOW = ['日', '一', '二', '三', '四', '五', '六'];
  const [, m, d] = state.today.split('-').map(Number);
  const dow = DOW[new Date().getDay()];
  $('date-line').textContent = `${m} 月 ${d} 日 · 周${dow}`;

  const total = state.checklist.length;
  const taken = state.checklist.filter((i) => state.intakeMap.get(intakeKey(i))?.taken).length;
  $('progress-fill').style.width = total ? `${(taken / total) * 100}%` : '0%';
  $('progress-text').textContent = `${taken}/${total}`;
}

function renderAll() {
  renderWeekStrip();
  renderModeBadge();
  renderHero();
  renderChecklist($('checklist'), state.checklist, state.intakeMap, onToggleIntake);
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
async function onToggleIntake(item, nextTaken) {
  if (state.degraded) return;
  const row = {
    date: state.today,
    supplement: item.supplement,
    slot: item.slot,
    dose: item.dose,
    taken: nextTaken,
    mode: state.modeInfo.mode,
  };
  state.intakeMap.set(intakeKey(item), row); // 乐观更新
  renderChecklist($('checklist'), state.checklist, state.intakeMap, onToggleIntake);
  renderHero();
  try {
    await db.upsertIntake([row]);
  } catch (e) {
    row.taken = !nextTaken;
    renderChecklist($('checklist'), state.checklist, state.intakeMap, onToggleIntake);
    renderHero();
    console.error(e);
  }
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
