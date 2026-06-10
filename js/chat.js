// 聊天流程状态机：输入 → loading → 预览卡（可直接修改）→ 确认写库。
// AI 只做翻译，落库前必须经过这张预览卡（spec §5.3，不可省）。

import { filterIntakeToChecklist, sanitizeSymptoms, sanitizeCycle, AiError } from './ai.js';
import { severityLabel } from './symptoms.js';

const SLOT_SHORT = { wake: '醒', lunch: '午', dinner: '晚', bedtime: '睡前' };

// opts: { logEl, input, sendBtn, getContext, parse, onCommit }
//  getContext() → { date, mode, checklist, fixedSymptoms }
//  parse(text, context) → Promise<{intake, symptoms, cycle, clarify}>
//  onCommit({intake, symptoms, cycle}) → Promise（由 app 负责写库与刷新）
export function initChat({ logEl, input, sendBtn, getContext, parse, onCommit }) {
  let busy = false;

  async function send() {
    const text = input.value.trim();
    if (!text || busy) return;
    busy = true;
    sendBtn.disabled = true;
    input.value = '';
    addBubble(logEl, 'user', text);
    const thinking = addBubble(logEl, 'tabby thinking', 'Tabby 在想…');

    const context = getContext();
    let result;
    try {
      result = await parse(text, context);
    } catch (e) {
      thinking.remove();
      const msg =
        e instanceof AiError && e.kind === 'timeout'
          ? 'AI 响应超时了，可以直接在上面手动勾选～'
          : 'AI 暂时不可用，可以直接在上面手动勾选～';
      addBubble(logEl, 'tabby', msg);
      done();
      return;
    }
    thinking.remove();

    if (result.clarify) {
      addBubble(logEl, 'tabby', result.clarify);
      done();
      return;
    }

    // 落库前的安全规整：intake 白名单过滤、symptoms/cycle 规整
    const draft = {
      intake: filterIntakeToChecklist(result.intake, context.checklist),
      symptoms: sanitizeSymptoms(result.symptoms, context.fixedSymptoms),
      cycle: sanitizeCycle(result.cycle),
    };
    if (!draft.intake.length && !draft.symptoms.length && !draft.cycle) {
      addBubble(logEl, 'tabby', '没听出来要记什么…再说具体一点？');
      done();
      return;
    }
    renderPreviewCard(draft);
    done();
  }

  function done() {
    busy = false;
    sendBtn.disabled = false;
    scrollToBottom();
  }

  function renderPreviewCard(draft) {
    const card = document.createElement('div');
    card.className = 'preview-card';
    const hint = document.createElement('div');
    hint.className = 'hint';
    hint.textContent = '确认一下：点补剂行切换吃没吃，点症状调程度，✕ 删除';
    card.appendChild(hint);
    rebuild();
    logEl.appendChild(card);
    scrollToBottom();

    function rebuild() {
      card.querySelectorAll('.section-title, .preview-row, .preview-actions').forEach((n) => n.remove());

      if (draft.intake.length) {
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
        card.appendChild(sectionTitle('症状'));
        draft.symptoms.forEach((s, idx) => {
          const row = document.createElement('button');
          row.className = 'preview-row';
          row.innerHTML = `<span class="mark">♥</span><span class="pname"></span><span class="meta"></span><span class="remove">✕</span>`;
          row.querySelector('.pname').textContent = s.symptom + (s.is_custom ? '（新）' : '');
          row.querySelector('.meta').textContent = severityLabel(s.severity);
          row.addEventListener('click', (e) => {
            if (e.target.classList.contains('remove')) {
              draft.symptoms.splice(idx, 1);
            } else {
              s.severity = (s.severity + 1) % 4; // 点击循环 无→轻→中→重
            }
            rebuild();
          });
          card.appendChild(row);
        });
      }

      if (draft.cycle) {
        card.appendChild(sectionTitle('周期'));
        const row = document.createElement('button');
        row.className = 'preview-row';
        row.innerHTML = `<span class="mark">☾</span><span class="pname"></span><span class="remove">✕</span>`;
        const EVENT_LABELS = {
          period_start: '经期开始',
          period_end: '经期结束',
          pms_start: '进入 PMS',
          jelly: '果冻状分泌物',
          bleed_light: '少量出血',
          bleed_heavy: '经期血量出血',
        };
        row.querySelector('.pname').textContent =
          `${EVENT_LABELS[draft.cycle.event]} · ${draft.cycle.date}`;
        row.addEventListener('click', (e) => {
          if (e.target.classList.contains('remove')) {
            draft.cycle = null;
            rebuild();
          }
        });
        card.appendChild(row);
      }

      const actions = document.createElement('div');
      actions.className = 'preview-actions';
      const cancel = document.createElement('button');
      cancel.className = 'btn ghost';
      cancel.textContent = '算了';
      cancel.addEventListener('click', () => card.remove());
      const confirm = document.createElement('button');
      confirm.className = 'btn primary';
      confirm.textContent = '确认记录';
      confirm.addEventListener('click', async () => {
        confirm.disabled = true;
        confirm.textContent = '记录中…';
        try {
          // onCommit 可返回一句"推算结果"反馈（如"经期从 6/8 起算，今天 Day 3"）
          const msg = await onCommit(draft);
          card.remove();
          addBubble(logEl, 'tabby', msg || '记好啦 ✓');
        } catch (e) {
          confirm.disabled = false;
          confirm.textContent = '确认记录';
          addBubble(logEl, 'tabby', '写入失败了，稍后再试或手动勾选');
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
}

function addBubble(logEl, cls, text) {
  const el = document.createElement('div');
  el.className = `bubble ${cls}`;
  el.textContent = text;
  logEl.appendChild(el);
  window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
  return el;
}
