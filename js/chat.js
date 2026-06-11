// 聊天流程状态机：输入 → loading → 预览卡（可直接修改）→ 确认写库。
// AI 只做翻译，落库前必须经过这张预览卡（spec §5.3，不可省）。

import {
  filterIntakeToChecklist,
  sanitizeSymptoms,
  sanitizeCycles,
  sanitizeRemove,
  removeRequiresIntent,
  dropContradictoryCycles,
  AiError,
} from './ai.js';
import { severityLabel } from './symptoms.js';

const SLOT_SHORT = { wake: '醒', lunch: '午', dinner: '晚', bedtime: '睡前' };
const REMOVE_LABELS = {
  last: '撤销刚才记的那条',
  cycle_today: '删掉今天的周期记录',
  symptoms_today: '删掉今天记的全部症状',
};
const EVENT_LABELS = {
  period_start: '经期开始',
  period_end: '经期结束',
  pms_start: '进入 PMS',
  jelly: '果冻状分泌物',
  bleed_light: '少量出血',
  bleed_heavy: '经期血量出血',
  not_period: '确认不是月经',
};

// opts: { logEl, input, sendBtn, getContext, parse, onCommit, onWake }
//  getContext() → { date, mode, checklist, fixedSymptoms }
//  parse(text, context) → Promise<{intake, symptoms, cycle, remove, clarify}>
//  onCommit(draft) → Promise<string|null>（由 app 负责写库与刷新，可返回反馈语）
export function initChat({ logEl, input, sendBtn, getContext, parse, onCommit, onWake }) {
  let busy = false;
  const history = []; // 最近几轮对话，让"都有"这类省略表达能接上文

  function remember(role, content) {
    history.push({ role, content });
    while (history.length > 6) history.shift();
  }

  async function send() {
    const text = input.value.trim();
    if (!text || busy) return;
    busy = true;
    sendBtn.disabled = true;
    input.value = '';
    addBubble(logEl, 'user', text);
    const thinking = addBubble(logEl, 'tabby thinking', 'Tabby 想想喵');

    const context = { ...getContext(), history: [...history] };
    remember('user', text);
    let result;
    try {
      result = await parse(text, context);
    } catch (e) {
      thinking.remove();
      const msg =
        e instanceof AiError && e.kind === 'timeout'
          ? '呜…等不到 AI 回话了喵，主人先手动勾选吧 (=；ω；=)'
          : '呜…AI 暂时联系不上喵，主人先手动勾选吧 (=；ω；=)';
      addBubble(logEl, 'tabby', msg);
      done();
      return;
    }
    thinking.remove();

    if (result.clarify) {
      remember('assistant', result.clarify);
      addBubble(logEl, 'tabby', result.clarify);
      done();
      return;
    }

    // 落库前的安全规整：intake 白名单过滤、symptoms/cycle/remove 规整
    const draft = {
      intake: filterIntakeToChecklist(result.intake, context.checklist),
      symptoms: sanitizeSymptoms(result.symptoms, context.fixedSymptoms),
      cycles: sanitizeCycles(result.cycle),
      remove: sanitizeRemove(result.remove),
    };
    draft.remove = removeRequiresIntent(draft.remove, text); // 没说删就不许删
    draft.cycles = dropContradictoryCycles(draft.cycles, draft.remove);
    if (!draft.intake.length && !draft.symptoms.length && !draft.cycles.length && !draft.remove) {
      addBubble(logEl, 'tabby', '没听懂主人想记什么喵…再说具体一点好不好 ฅ(•ㅅ•)ฅ');
      done();
      return;
    }
    renderPreviewCard(draft, context);
    done();
  }

  function done() {
    busy = false;
    sendBtn.disabled = false;
    scrollToBottom();
  }

  function renderPreviewCard(draft, context) {
    const card = document.createElement('div');
    card.className = 'preview-card';
    rebuild();
    logEl.appendChild(card);
    scrollToBottom();

    // "今天都吃了"= 覆盖全清单且全勾 → 折叠成一行摘要，不列整个 list
    function isFullDefault() {
      return (
        draft.intake.length > 0 &&
        draft.intake.length === context.checklist.length &&
        draft.intake.every((i) => i.taken)
      );
    }

    function rebuild() {
      card
        .querySelectorAll('.section-title, .preview-row, .preview-actions, .preview-summary')
        .forEach((n) => n.remove());

      if (draft.remove) {
        card.appendChild(sectionTitle('删除'));
        if (draft.remove.what === 'cycle_events') {
          // 按条删过去的周期记录：每行可单独点 ✕ 从删除列表里剔除
          draft.remove.items.forEach((it, idx) => {
            const row = document.createElement('button');
            row.className = 'preview-row';
            row.innerHTML = `<span class="mark off-mark">✕</span><span class="pname"></span><span class="remove">✕</span>`;
            row.querySelector('.pname').textContent = `删掉 ${EVENT_LABELS[it.event]} · ${it.date}`;
            row.addEventListener('click', (e) => {
              if (e.target.classList.contains('remove')) {
                draft.remove.items.splice(idx, 1);
                if (!draft.remove.items.length) draft.remove = null;
                rebuild();
              }
            });
            card.appendChild(row);
          });
        } else {
          const row = document.createElement('div');
          row.className = 'preview-row';
          row.innerHTML = `<span class="mark off-mark">✕</span><span class="pname"></span>`;
          row.querySelector('.pname').textContent = REMOVE_LABELS[draft.remove.what];
          card.appendChild(row);
        }
      }

      if (isFullDefault()) {
        const sum = document.createElement('div');
        sum.className = 'preview-summary';
        sum.textContent = `✓ 今日清单全部完成（${draft.intake.length} 项）`;
        card.appendChild(sum);
      } else if (draft.intake.length) {
        card.appendChild(sectionTitle('补剂'));
        draft.intake.forEach((item) => {
          const row = document.createElement('button');
          row.className = `preview-row${item.taken ? '' : ' off'}`;
          row.innerHTML = `<span class="mark"></span><span class="pname"></span><span class="meta"></span>`;
          row.querySelector('.mark').textContent = item.taken ? '✓' : '✕';
          row.querySelector('.pname').textContent = item.supplement;
          row.querySelector('.meta').textContent = `${SLOT_SHORT[item.slot]} · ${item.dose}`;
          row.addEventListener('click', () => {
            item.taken = !item.taken;
            rebuild();
          });
          card.appendChild(row);
        });
      }

      if (draft.symptoms.length) {
        card.appendChild(sectionTitle('症状 · 选程度'));
        draft.symptoms.forEach((s, idx) => {
          const row = document.createElement('div');
          row.className = 'preview-row sym';
          const name = document.createElement('span');
          name.className = 'pname';
          name.textContent = s.symptom + (s.is_custom ? '（新）' : '');
          const seg = document.createElement('span');
          seg.className = 'seg';
          for (const sev of [1, 2, 3]) {
            const b = document.createElement('button');
            b.className = `seg-btn sev-${sev}${s.severity === sev ? ' on' : ''}`;
            b.textContent = severityLabel(sev);
            b.addEventListener('click', () => {
              s.severity = sev;
              rebuild();
            });
            seg.appendChild(b);
          }
          const rm = document.createElement('button');
          rm.className = 'remove';
          rm.textContent = '✕';
          rm.addEventListener('click', () => {
            draft.symptoms.splice(idx, 1);
            rebuild();
          });
          row.append(name, seg, rm);
          card.appendChild(row);
        });
      }

      if (draft.cycles.length) {
        card.appendChild(sectionTitle('周期'));
        draft.cycles.forEach((c, idx) => {
          const row = document.createElement('button');
          row.className = 'preview-row';
          row.innerHTML = `<span class="mark">☾</span><span class="pname"></span><span class="remove">✕</span>`;
          row.querySelector('.pname').textContent = `${EVENT_LABELS[c.event]} · ${c.date}`;
          row.addEventListener('click', (e) => {
            if (e.target.classList.contains('remove')) {
              draft.cycles.splice(idx, 1);
              rebuild();
            }
          });
          card.appendChild(row);
        });
      }

      const actions = document.createElement('div');
      actions.className = 'preview-actions';
      const cancel = document.createElement('button');
      cancel.className = 'btn ghost';
      cancel.textContent = '算了';
      cancel.addEventListener('click', () => card.remove());
      const confirm = document.createElement('button');
      confirm.className = 'btn primary';
      confirm.textContent = draft.remove
        ? '确认删除'
        : isFullDefault()
          ? '确认按默认记录'
          : '确认记录';
      confirm.addEventListener('click', async () => {
        confirm.disabled = true;
        confirm.textContent = '记录中…';
        try {
          // onCommit 可返回一句"推算结果"反馈（如"经期从 6/8 起算，今天 Day 3"）
          const msg = await onCommit(draft);
          card.remove();
          addBubble(logEl, 'tabby', msg || '记好啦喵 ✓ ฅ^•ﻌ•^ฅ');
        } catch (e) {
          confirm.disabled = false;
          confirm.textContent = '确认记录';
          addBubble(logEl, 'tabby', '呜呜写入失败了喵…主人稍后再试或手动勾选 (´；ω；`)');
          console.error(e);
        }
        scrollToBottom();
      });
      actions.append(cancel, confirm);
      card.appendChild(actions);
    }
  }

  function sectionTitle(text) {
    const el = document.createElement('div');
    el.className = 'section-title';
    el.textContent = text;
    return el;
  }

  function scrollToBottom() {
    window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
  }

  sendBtn.addEventListener('click', send);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') send();
  });
  if (onWake) {
    input.addEventListener('focus', () => onWake(true));
    input.addEventListener('blur', () => onWake(false));
  }
}

export function addBubble(logEl, cls, text) {
  const el = document.createElement('div');
  el.className = `bubble ${cls}`;
  el.textContent = text;
  logEl.appendChild(el);
  window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
  return el;
}
