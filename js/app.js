// 入口：主题 → SW 注册 → 拉数据 → 推算状态 → 渲染各区 → 装配交互。
// Supabase 拉取失败时降级为只读（本地清单仍可见）。

import { cycleConfig, PMS_MARKER_SYMPTOMS } from './config.js';
import { appToday, weekOf, addDays, diffDays } from './dates.js';
import { getChecklist } from './protocol.js';
import { deriveState } from './cycle.js';
import * as realDb from './db.js';
import { parseUtterance } from './ai.js';
import { renderChecklist, intakeKey } from './checklist.js';
import { renderSymptoms, severityLevel, severityLevelLabel } from './symptoms.js';
import { initChat, addBubble } from './chat.js';
import { makeMockDb, mockParse } from './mock.js';

const MOCK = new URLSearchParams(location.search).has('mock');
const db = MOCK ? makeMockDb() : realDb;
const parse = MOCK ? mockParse : parseUtterance;

const $ = (id) => document.getElementById(id);

const state = {
  today: appToday(),
  modeInfo: {},
  checklist: [],
  intakeMap: new Map(),
  todaySymptoms: [],
  rangeSymptoms: new Map(), // 日历可见范围 date → 当日症状（PMS 色带浓度用）
  fixedSymptoms: [],
  cycleEvents: [],
  degraded: false,
  // 撤销"刚刚那条"用：最近一次聊天确认的快照
  lastCommit: null, // { prevIntake: [[key,row|null]], symptoms: [name], cycle: {event,date}|null }
};

const md = (s) => `${Number(s.slice(5, 7))}/${Number(s.slice(8))}`;

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

/* ---------- 顶栏日期 ---------- */
{
  const DOW = ['日', '一', '二', '三', '四', '五', '六'];
  const [, m, d] = state.today.split('-').map(Number);
  $('today-line').textContent = `${m}月${d}日 · 周${DOW[new Date().getDay()]}`;
}

/* ---------- PWA：注册 + 自动更新 ----------
   每次打开/回到前台都主动检查新版本；新 SW 接管时自动刷新一次页面，
   用户无需"关掉重开两次"。 */
if ('serviceWorker' in navigator && !MOCK) {
  navigator.serviceWorker
    .register('./sw.js')
    .then((reg) => {
      reg.update().catch(() => {});
      document.addEventListener('visibilitychange', () => {
        if (!document.hidden) reg.update().catch(() => {});
      });
    })
    .catch(() => {});
  let reloaded = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloaded) return; // 防刷新循环
    reloaded = true;
    location.reload();
  });
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
  const modeOf = (d) =>
    d > state.today ? null : (() => {
      const m = deriveState(ev, d, cycleConfig).mode;
      return m === 'daily' ? null : m;
    })();

  // 同一行内相邻同状态自然连成一条（荧光笔/下划线都按 run 起止圆角）
  const runEdges = (i, d, has) => {
    const prev = i % 7 === 0 ? false : has(days[i - 1]);
    const next = i % 7 === 6 || i + 1 >= days.length ? false : has(days[i + 1]);
    return { start: !prev, end: !next };
  };

  days.forEach((d, i) => {
    const mode = modeOf(d);
    const cell = document.createElement('div');
    cell.className =
      'bw-day' + (d === state.today ? ' today' : '') + (d > state.today ? ' future' : '');

    // 荧光笔涂抹（经期/PMS）；PMS 浓度跟随当日症状严重度（平稳50/轻75/明显100%）
    if (mode) {
      const hl = document.createElement('span');
      const e = runEdges(i, d, (x) => modeOf(x) === mode);
      const sev = mode === 'pms' ? ` sev-${severityLevel(state.rangeSymptoms.get(d))}` : '';
      hl.className = `hl ${mode}${sev}${e.start ? ' run-start' : ''}${e.end ? ' run-end' : ''}`;
      cell.appendChild(hl);
    }

    const num = document.createElement('span');
    num.className = 'num';
    num.textContent = String(Number(d.slice(8)));
    cell.appendChild(num);

    // 排卵日（推算落定后）：日期下橙黄色小圈圈
    if (d === state.modeInfo.ovulationDate) {
      const ring = document.createElement('span');
      ring.className = 'ovu-mark';
      cell.appendChild(ring);
    }

    // 下划线（出血/果冻观察）：默认同一水平面，同一天两者都有才分上下
    const uls = document.createElement('span');
    uls.className = 'uls';
    // 经期色带覆盖不正出血：经期日不画出血下划线
    const spotHas = (x) => bleedDates.has(x) && modeOf(x) !== 'period';
    const dayMarks = [
      ...(spotHas(d) ? [['bleed', spotHas]] : []),
      ...(jellyDates.has(d) ? [['jelly', (x) => jellyDates.has(x)]] : []),
    ];
    for (const [cls, has] of dayMarks) {
      const ul = document.createElement('i');
      const e = runEdges(i, d, has);
      ul.className = `ul ${cls}${e.start ? ' run-start' : ''}${e.end ? ' run-end' : ''}`;
      uls.appendChild(ul);
    }
    cell.appendChild(uls);
    el.appendChild(cell);
  });
}

/* ---------- 顶栏状态胶囊 ----------
   只在经期/排卵期/黄体期显示 Day N；正常不显示，
   PMS 也不进胶囊（日历紫色带已表达，黄体期照常显示） */
function renderTopbarMode() {
  const { mode, dayN, ovulationDayN, daysSinceOvulation, phase } = state.modeInfo;
  const chip = $('topbar-mode');
  const label =
    mode === 'period' ? `🩸 经期 Day ${dayN}`
    : phase === 'ovulation' ? `🔅 排卵期 Day ${ovulationDayN}`
    : phase === 'luteal' ? `💜 黄体期 Day ${daysSinceOvulation}`
    : null;
  chip.hidden = !label;
  chip.textContent = label ?? '';
}

/* ---------- 统计 + 打卡按钮状态 ---------- */
// 三个统计位都可点按切换显示内容，选择记在 localStorage
const statView = {
  get: (key) => localStorage.getItem(`tabby-stat-${key}`) === '1',
  toggle: (key) => localStorage.setItem(`tabby-stat-${key}`, statView.get(key) ? '0' : '1'),
};

// "排卵后第 N 天"从排卵日第二天起才有得看（之前点了也不切换）
function ovulationViewReady() {
  const { daysSinceOvulation } = state.modeInfo;
  return daysSinceOvulation !== null && daysSinceOvulation >= 1;
}

function renderStats() {
  const { daysSinceEnd, ovulationPending, daysSinceOvulation, predictedPeriod } = state.modeInfo;

  // 栏一：距上次经期 / 排卵后第 N 天
  if (ovulationViewReady() && statView.get('recent')) {
    $('stat-recent-label').textContent = '排卵后';
    $('stat-recent').textContent = `第 ${daysSinceOvulation} 天`;
  } else {
    $('stat-recent-label').textContent = '经期结束后';
    $('stat-recent').textContent = daysSinceEnd === null ? '—' : `${daysSinceEnd} 天`;
  }

  // 栏二：预测经期窗口日期 / 还有 N 天
  if (predictedPeriod) {
    const n = diffDays(state.today, predictedPeriod.start);
    $('stat-predict').textContent = statView.get('predict')
      ? n > 0 ? `还有 ${n} 天` : '就这几天'
      : `${md(predictedPeriod.start)}~${md(predictedPeriod.end)}`;
  } else {
    $('stat-predict').textContent = ovulationPending ? '排卵中…' : '—';
  }

  // 栏三：今日症状 N 项 / 严重度三档
  $('stat-symptoms').textContent = statView.get('symptoms')
    ? severityLevelLabel(severityLevel(state.todaySymptoms))
    : `${state.todaySymptoms.filter((s) => s.severity > 0).length} 项`;

  const total = state.checklist.length;
  const taken = state.checklist.filter((i) => state.intakeMap.get(intakeKey(i))?.taken).length;
  const allDone = total > 0 && taken === total;
  $('done-btn').classList.toggle('done', allDone); // done 态显示盖章的小猫
  $('done-label').textContent = '长按打卡';
  // 文案保持等长短句：左栏宽度恒定，状态切换不再挤动右侧统计列
  $('done-sub').textContent = allDone ? `今日 ${taken}/${total} ✓` : `今日 ${taken}/${total}`;
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

function initStatToggles() {
  $('stat-recent-btn').addEventListener('click', () => {
    if (!ovulationViewReady()) return;
    statView.toggle('recent');
    renderStats();
  });
  $('stat-predict-btn').addEventListener('click', () => {
    statView.toggle('predict');
    renderStats();
  });
  $('stat-symptoms-btn').addEventListener('click', () => {
    statView.toggle('symptoms');
    renderStats();
  });
}

function renderAll() {
  renderCalendar();
  renderTopbarMode();
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

// 周期事件确认后，用一句话反馈推算结果（三层判定的结果在这里变得可见）
function cycleFeedback(cycles) {
  const { mode, dayN, periodStart, ovulationPending, predictedPeriod, spottingToday, suspectBleed, phase } = state.modeInfo;
  const windowTail = predictedPeriod
    ? `照黄体期推算，月经大约 ${md(predictedPeriod.start)}~${md(predictedPeriod.end)} 之间来喵`
    : '';
  if (cycles.length > 1) {
    const tail =
      mode === 'period' ? `现在是经期 Day ${dayN}（从 ${md(periodStart)} 起算）`
      : phase === 'ovulation' ? '现在是排卵期'
      : phase === 'luteal' ? '现在是黄体期'
      : '';
    return `补记好了喵！${cycles.length} 条都记上了，状态重新算过。${tail} (=^･ω･^=)`;
  }
  const event = cycles[0].event;
  if (event === 'period_start') {
    if (mode === 'period') {
      return dayN > 1
        ? `记好啦喵！主人说了算，经期从 ${md(periodStart)} 起算，今天 Day ${dayN} (=^･ω･^=)`
        : '记好啦喵！经期 Day 1，补剂清单切换好了，主人多保重 (=^･ω･^=)';
    }
  }
  if (event === 'bleed_heavy') {
    if (mode === 'period') {
      return `记好啦喵！这段出血判定为经期，今天 Day ${dayN}（从 ${md(periodStart)} 起算）(=^･ω･^=)`;
    }
    return suspectBleed
      ? '记好啦喵～这次出血有点突然，Tabby 待会儿想和主人确认一下是不是月经喵 ฅ(•ㅅ•)ฅ'
      : '记好啦喵～先记为出血观察；要是明天还在出血，会自动判成经期的喵 ฅ(•ㅅ•)ฅ';
  }
  if (event === 'bleed_light') {
    return mode === 'period'
      ? `记好啦喵！这段出血并入经期，今天 Day ${dayN} (=^･ω･^=)`
      : spottingToday
        ? '记好啦喵～暂记为孤立少量出血；要是之后血量上来，Tabby 会自动重新判断的喵 ฅ(•ㅅ•)ฅ'
        : '记好啦喵 ✓';
  }
  if (event === 'not_period') {
    return '明白了喵，这次出血不算月经，记成孤立出血了。主人要多留意身体喵 ฅ(•ㅅ•)ฅ';
  }
  if (event === 'jelly') {
    return ovulationPending
      ? '记好啦喵～果冻段还在继续，等黏液消退排卵日会自动落定（=段末次日）喵 ฅ^•ﻌ•^ฅ'
      : `记好啦喵 ✓ ${windowTail}`;
  }
  if (event === 'pms_start') return '记好啦喵！已进入 PMS 模式，B6 和镁都加量了，主人请多照顾自己喵 (=ↀωↀ=)';
  if (event === 'period_end') return '记好啦喵！经期结束，清单回到日常，主人辛苦了喵 ฅ^•ﻌ•^ฅ';
  return '记好啦喵 ✓ ฅ^•ﻌ•^ฅ';
}

/* ---------- 通用确认弹窗（取消打卡等用） ---------- */
function askConfirm(text, okLabel = '确认') {
  return new Promise((resolve) => {
    const layer = document.createElement('div');
    layer.className = 'modal-layer';
    const box = document.createElement('div');
    box.className = 'modal-box';
    const p = document.createElement('div');
    p.className = 'modal-text';
    p.textContent = text;
    const actions = document.createElement('div');
    actions.className = 'preview-actions';
    const no = document.createElement('button');
    no.className = 'btn ghost';
    no.textContent = '算了';
    const yes = document.createElement('button');
    yes.className = 'btn primary';
    yes.textContent = okLabel;
    no.addEventListener('click', () => { layer.remove(); resolve(false); });
    yes.addEventListener('click', () => { layer.remove(); resolve(true); });
    actions.append(no, yes);
    box.append(p, actions);
    layer.appendChild(box);
    document.body.appendChild(layer);
  });
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
  // 取消已打的卡要确认一遍（防误触）
  if (!nextTaken) {
    const ok = await askConfirm(`要取消「${item.supplement}」的打卡吗喵？`, '取消打卡');
    if (!ok) return;
  }
  const key = intakeKey(item);
  const prev = [[key, state.intakeMap.get(key)]];
  state.intakeMap.set(key, intakeRowOf(item, nextTaken)); // 乐观更新
  renderList();
  renderStats();
  await persistIntake([state.intakeMap.get(key)], prev);
}

async function onToggleSlot(items, nextTaken) {
  if (state.degraded) return;
  if (!nextTaken) {
    const ok = await askConfirm('要取消这一时段的全部打卡吗喵？', '取消打卡');
    if (!ok) return;
  }
  const prev = items.map((i) => [intakeKey(i), state.intakeMap.get(intakeKey(i))]);
  const rows = items.map((i) => intakeRowOf(i, nextTaken));
  rows.forEach((r, idx) => state.intakeMap.set(intakeKey(items[idx]), r));
  renderList();
  renderStats();
  await persistIntake(rows, prev);
}

async function onLogSymptom(symptom, severity, isCustom) {
  if (state.degraded) return;
  if (severity === 0) {
    // "清除" = 真删除这条记录
    await db.deleteSymptom(state.today, symptom);
  } else {
    await db.upsertSymptoms([
      { date: state.today, symptom, severity, is_custom: isCustom },
    ]);
    if (isCustom) await db.bumpSymptomCatalog(symptom).catch(() => {});
  }
  state.todaySymptoms = await db.fetchTodaySymptoms(state.today);
  state.rangeSymptoms.set(state.today, state.todaySymptoms);
  renderAll();
  maybePromptPms();
}

/* ---------- 长按打卡：渐变进度环转满一圈 ---------- */
const ARC_C = 2 * Math.PI * 50; // 与 SVG r=50 一致
function initDoneButton() {
  const btn = $('done-btn');
  const arc = $('done-arc');
  arc.style.strokeDasharray = ARC_C;
  arc.style.strokeDashoffset = ARC_C;
  const HOLD_MS = 700;
  let timer = null;

  const reset = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    arc.style.transition = 'stroke-dashoffset 0.18s ease';
    arc.style.strokeDashoffset = ARC_C;
  };

  btn.addEventListener('pointerdown', (e) => {
    if (state.degraded) return;
    e.preventDefault();
    arc.style.transition = `stroke-dashoffset ${HOLD_MS}ms linear`;
    requestAnimationFrame(() => (arc.style.strokeDashoffset = 0));
    timer = setTimeout(async () => {
      reset();
      // 已全选时再长按一次 = 取消全选
      const total = state.checklist.length;
      const taken = state.checklist.filter((i) => state.intakeMap.get(intakeKey(i))?.taken).length;
      if (total > 0 && taken === total) {
        await markAll(false);
        celebrate('取消全选啦喵', false);
      } else {
        await markAll(true);
        celebrate('太棒了喵！୧ ₍៸៸᳐⦁𖥦⦁៸៸᳐ ₎', true);
      }
    }, HOLD_MS);
  });
  btn.addEventListener('pointerup', reset);
  btn.addEventListener('pointercancel', reset);
  btn.addEventListener('pointerleave', reset);
  btn.addEventListener('contextmenu', (e) => e.preventDefault()); // 防 iOS 长按弹菜单
}

async function markAll(taken) {
  const items = state.checklist;
  const prev = items.map((i) => [intakeKey(i), state.intakeMap.get(intakeKey(i))]);
  const rows = items.map((i) => intakeRowOf(i, taken));
  rows.forEach((r, idx) => state.intakeMap.set(intakeKey(items[idx]), r));
  renderList();
  renderStats();
  await persistIntake(rows, prev);
}

// 完成反馈：小猫 logo 像盖章一样砸在按钮上 + 气泡 + 震动
// （iOS Safari 不支持网页震动 API，iPhone 上以盖章顿挫动画作为反馈）
function celebrate(text, stamp) {
  navigator.vibrate?.(80);
  const btn = $('done-btn');
  if (stamp) {
    btn.classList.remove('stamp-in');
    void btn.offsetWidth; // 重置动画
    btn.classList.add('stamp-in');
  }
  const say = $('done-say');
  say.textContent = text;
  say.hidden = false;
  setTimeout(() => (say.hidden = true), 2000);
}

/* ---------- 页脚版本号 ---------- */
// 问"正在掌管页面的 SW"拿缓存版本——显示的就是实际运行的版本，更新没到位一眼可见
function initVersionTag() {
  const el = $('version-tag');
  if (MOCK || !('serviceWorker' in navigator)) {
    el.textContent = 'dev';
    return;
  }
  navigator.serviceWorker.addEventListener('message', (e) => {
    if (e.data?.version) el.textContent = e.data.version.replace('tabby-shell-', '');
  });
  const ask = () => navigator.serviceWorker.controller?.postMessage('version');
  navigator.serviceWorker.ready.then(ask);
}

/* ---------- 分割线小猫：跟随输入框激活（聚焦=醒+变粉，离开=睡） ---------- */
function initChatCat() {
  const cat = $('chat-cat');
  const divider = document.querySelector('.chat-divider');
  const SLEEP = '(=˘ω˘=) zzZ';
  const FRAMES = ['(=^･ω･^=)∫', '(=^･ω･^=)ʃ'];
  let wag = null;
  let frame = 0;

  const listen = $('chat-listen');
  const sleep = () => {
    if (wag) clearInterval(wag);
    wag = null;
    cat.textContent = SLEEP;
    cat.classList.remove('awake');
    divider.classList.remove('awake');
    listen.hidden = true;
  };
  const wake = () => {
    if (wag) return;
    cat.classList.add('awake');
    divider.classList.add('awake');
    listen.hidden = false;
    cat.textContent = FRAMES[0];
    wag = setInterval(() => {
      frame = 1 - frame;
      cat.textContent = FRAMES[frame];
    }, 450);
  };
  return (awake) => (awake ? wake() : setTimeout(sleep, 2500));
}

/* ---------- PMS 症状询问 ---------- */
// 记录到典型 PMS 症状且当前是日常模式 → 询问是否进入 PMS（确认才切，不自动）
function maybePromptPms() {
  const existing = document.getElementById('pms-ask');
  const hit =
    !state.degraded &&
    state.modeInfo.mode === 'daily' &&
    state.todaySymptoms.some(
      (s) => s.severity > 0 && PMS_MARKER_SYMPTOMS.includes(s.symptom)
    ) &&
    localStorage.getItem('tabby-pms-dismissed') !== state.today;
  if (!hit) {
    existing?.remove(); // 条件不再成立（症状删了/已进 PMS）→ 撤掉残留的询问卡
    return;
  }
  if (existing) return;

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
      addBubble($('chat-log'), 'tabby', '已进入 PMS 模式喵！清单加上 B6、镁加到 300mg，主人要好好照顾自己 (=ↀωↀ=)');
    } catch (e) {
      yes.disabled = false;
      console.error(e);
    }
  });
  actions.append(later, yes);
  card.append(text, actions);
  $('chat-log').appendChild(card);
}

/* ---------- 疑似不正出血询问 ---------- */
// 推算器对两类出血不自动下结论（孤立单日经期量 / 经期刚结束又出血），
// 弹卡问主人；答案落 period_start / not_period，"先不喵"按疑点日期永久静音。
function maybePromptSuspectBleed() {
  const existing = document.getElementById('bleed-ask');
  const s = state.modeInfo.suspectBleed;
  const hit =
    !state.degraded && s && localStorage.getItem('tabby-bleed-dismissed') !== s.date;
  if (!hit) {
    existing?.remove(); // 疑点已被宣告解决/静音 → 撤掉残留的询问卡
    return;
  }
  if (existing) return;

  const card = document.createElement('div');
  card.id = 'bleed-ask';
  card.className = 'preview-card';
  const text = document.createElement('div');
  text.className = 'pms-ask-text';
  text.textContent =
    s.reason === 'post_period'
      ? `主人，经期刚结束没几天，${md(s.date)} 又记到出血了喵…这是新一次月经吗？ฅ(•ㅅ•)ฅ`
      : `主人，${md(s.date)} 那天孤零零一次经期量出血，离排卵窗口和上次经期都有点远喵…这是月经吗？ฅ(•ㅅ•)ฅ`;
  const actions = document.createElement('div');
  actions.className = 'preview-actions';

  const answer = async (event, reply) => {
    try {
      await db.insertCycleEvent({ event, date: s.date });
      state.cycleEvents = await db.fetchCycleEvents();
      recomputeMode();
      renderAll();
      card.remove();
      addBubble($('chat-log'), 'tabby', reply());
      maybePromptSuspectBleed(); // 可能还有别的疑点
    } catch (e) {
      console.error(e);
    }
  };

  const later = document.createElement('button');
  later.className = 'btn ghost';
  later.textContent = '先不喵';
  later.addEventListener('click', () => {
    localStorage.setItem('tabby-bleed-dismissed', s.date);
    card.remove();
  });
  const no = document.createElement('button');
  no.className = 'btn ghost';
  no.textContent = '不是月经';
  no.addEventListener('click', () =>
    answer('not_period', () => '明白了喵，记成孤立出血。不正出血要多留意，主人保重身体喵 ฅ(•ㅅ•)ฅ')
  );
  const yes = document.createElement('button');
  yes.className = 'btn primary';
  yes.textContent = '是月经';
  yes.addEventListener('click', () =>
    answer('period_start', () => {
      const { dayN, periodStart } = state.modeInfo;
      return dayN
        ? `好的喵！经期从 ${md(periodStart)} 起算，今天 Day ${dayN}，清单切换好了 (=^･ω･^=)`
        : '好的喵！记上了 (=^･ω･^=)';
    })
  );
  actions.append(later, no, yes);
  card.append(text, actions);
  $('chat-log').appendChild(card);
}

/* ---------- 删除/撤销 ---------- */
// 症状行只保留可重插的字段（select=* 带回的 id/created_at 不能进 upsert）
const symptomRowFields = (r) => ({
  date: r.date,
  symptom: r.symptom,
  severity: r.severity,
  is_custom: r.is_custom ?? false,
});

// 执行删除前先把被删的行存进 snapshot —— "撤销"时重插回去，删除也有后悔药
async function executeRemove(remove, snapshot) {
  if (remove.what === 'symptoms_today') {
    snapshot.deletedSymptoms = state.todaySymptoms
      .filter((s) => s.severity > 0)
      .map(symptomRowFields);
    await db.deleteSymptomsByDate(state.today);
    return '今天的症状记录都删掉了喵；想反悔说"撤销"就能找回 ฅ(•ㅅ•)ฅ';
  }
  if (remove.what === 'cycle_today') {
    snapshot.deletedCycles = state.cycleEvents
      .filter((e) => e.date === state.today)
      .map(({ event, date }) => ({ event, date }));
    await db.deleteCycleEventsByDate(state.today);
    return '今天的周期记录删掉了喵，状态重新算过了；想反悔说"撤销"就能找回 ฅ(•ㅅ•)ฅ';
  }
  if (remove.what === 'cycle_events') {
    // 只快照真实存在的条目：撤销重插时才不会凭空造出新记录
    const existing = new Set(state.cycleEvents.map((e) => `${e.event}|${e.date}`));
    snapshot.deletedCycles = remove.items.filter((it) => existing.has(`${it.event}|${it.date}`));
    await Promise.all(remove.items.map((it) => db.deleteCycleEvent(it)));
    return `删掉了 ${snapshot.deletedCycles.length} 条周期记录喵，状态重新算过了；想反悔说"撤销"就能找回 ฅ(•ㅅ•)ฅ`;
  }
  if (remove.what === 'symptom_entries') {
    const dates = [...new Set(remove.items.map((i) => i.date))].sort();
    const rows = await db.fetchSymptomsRange(dates[0], dates[dates.length - 1]);
    const want = new Set(remove.items.map((i) => `${i.date}|${i.symptom}`));
    snapshot.deletedSymptoms = rows
      .filter((r) => want.has(`${r.date}|${r.symptom}`))
      .map(symptomRowFields);
    await Promise.all(remove.items.map((i) => db.deleteSymptom(i.date, i.symptom)));
    return `删掉了 ${snapshot.deletedSymptoms.length} 条症状记录喵；想反悔说"撤销"就能找回 ฅ(•ㅅ•)ฅ`;
  }
  // what === 'last'：撤销最近一次聊天确认（新增→删掉，删掉→重插）
  const last = state.lastCommit;
  if (!last) return '咦…Tabby 不记得刚才记过什么了喵，要不直接说删哪条？(=･ｪ･=?';
  await Promise.all([
    ...(last.cycles ?? []).map((c) => db.deleteCycleEvent(c)),
    ...(last.symptoms ?? []).map((name) => db.deleteSymptom(state.today, name)),
    ...(last.deletedCycles ?? []).map((c) => db.insertCycleEvent(c)),
  ]);
  if ((last.deletedSymptoms ?? []).length) await db.upsertSymptoms(last.deletedSymptoms);
  if (last.prevIntake.length) {
    const rows = last.prevIntake.map(([key, row]) => {
      if (row) return row;
      const [supplement, slot] = key.split('|');
      const item = state.checklist.find((i) => i.supplement === supplement && i.slot === slot);
      return intakeRowOf(item ?? { supplement, slot, dose: '' }, false);
    });
    await db.upsertIntake(rows);
  }
  state.lastCommit = null;
  return '撤销好了喵，就当刚才什么都没发生 (=^･ω･^=)';
}

/* ---------- 预览卡确认后的统一落库（chat.js 回调） ---------- */
async function commitDraft(draft) {
  const snapshot = { prevIntake: [], symptoms: [], cycles: [], deletedCycles: [], deletedSymptoms: [] };
  let removeMsg = null;
  if (draft.remove) {
    removeMsg = await executeRemove(draft.remove, snapshot);
  }

  if (draft.intake.length) {
    snapshot.prevIntake = draft.intake.map((i) => {
      const key = `${i.supplement}|${i.slot}`;
      return [key, state.intakeMap.get(key) ?? null];
    });
    await db.upsertIntake(
      draft.intake.map((i) => ({ ...i, date: state.today, mode: state.modeInfo.mode }))
    );
  }
  if (draft.symptoms.length) {
    snapshot.symptoms = draft.symptoms.map((s) => s.symptom);
    await db.upsertSymptoms(draft.symptoms.map((s) => ({ ...s, date: state.today })));
    for (const s of draft.symptoms.filter((x) => x.is_custom)) {
      await db.bumpSymptomCatalog(s.symptom).catch(() => {});
    }
  }
  for (const c of draft.cycles) {
    snapshot.cycles.push(c);
    await db.insertCycleEvent(c);
  }
  // 有新增或有被删的快照才更新"刚刚那条"指针（"撤销"本身不算，免得撤销套娃）
  if (
    draft.intake.length || draft.symptoms.length || draft.cycles.length ||
    snapshot.deletedCycles.length || snapshot.deletedSymptoms.length
  ) {
    state.lastCommit = snapshot;
  }

  // 统一重拉重算（删除/周期事件都可能改变状态）
  const [events, intakeRows, symptomRows] = await Promise.all([
    db.fetchCycleEvents(),
    db.fetchTodayIntake(state.today),
    db.fetchTodaySymptoms(state.today),
  ]);
  state.cycleEvents = events;
  state.intakeMap = new Map(intakeRows.map((r) => [intakeKey(r), r]));
  state.todaySymptoms = symptomRows;
  state.rangeSymptoms.set(state.today, symptomRows);
  recomputeMode();
  renderAll();
  maybePromptPms();
  maybePromptSuspectBleed();

  if (removeMsg) return removeMsg;
  return draft.cycles.length ? cycleFeedback(draft.cycles) : null;
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
  initStatToggles();
  initVersionTag();
  const onWake = initChatCat();
  try {
    const calFrom = weekOf(addDays(state.today, -7))[0]; // 日历可见范围的第一天
    const [events, fixed, intakeRows, symptomRows, rangeRows] = await Promise.all([
      db.fetchCycleEvents(),
      db.fetchFixedSymptoms(),
      db.fetchTodayIntake(state.today),
      db.fetchTodaySymptoms(state.today),
      db.fetchSymptomsRange(calFrom, state.today),
    ]);
    state.cycleEvents = events;
    state.fixedSymptoms = fixed.map((r) => r.name);
    state.intakeMap = new Map(intakeRows.map((r) => [intakeKey(r), r]));
    state.todaySymptoms = symptomRows;
    state.rangeSymptoms = new Map();
    for (const r of rangeRows) {
      if (!state.rangeSymptoms.has(r.date)) state.rangeSymptoms.set(r.date, []);
      state.rangeSymptoms.get(r.date).push(r);
    }
    recomputeMode();
  } catch (e) {
    state.degraded = true;
    $('offline-banner').classList.remove('hidden');
    console.error(e);
  }
  renderAll();
  maybePromptPms();
  maybePromptSuspectBleed();

  initChat({
    logEl: $('chat-log'),
    input: $('chat-input'),
    sendBtn: $('chat-send'),
    getContext: () => ({
      date: state.today,
      mode: state.modeInfo.mode,
      checklist: state.checklist,
      fixedSymptoms: state.fixedSymptoms,
      // 最近的周期记录（倒序）：让 AI 能精确定位"删掉X号那条/整个经期"
      cycleEvents: state.cycleEvents.slice(0, 20).map(({ event, date }) => ({ event, date })),
    }),
    parse,
    onCommit: commitDraft,
    onWake,
  });
}

boot();
