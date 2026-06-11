// Edge Function 客户端 + AI 结果安全过滤。
// system prompt 在服务端组装，这里只传结构化上下文。

import { PARSE_FN_URL, SUPABASE_ANON_KEY } from './config.js';

export class AiError extends Error {
  constructor(kind, message) {
    super(message);
    this.kind = kind; // 'timeout' | 'unavailable' | 'parse_failed'
  }
}

// context = { date, mode, checklist, fixedSymptoms, history }
// history = 最近几轮对话（让"都有"这类省略表达能被正确理解）
// 返回 { intake, symptoms, cycle, remove, clarify }
export async function parseUtterance(userText, context) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  let res;
  try {
    res = await fetch(PARSE_FN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: SUPABASE_ANON_KEY,
      },
      body: JSON.stringify({ userText, context, history: context.history ?? [] }),
      signal: controller.signal,
    });
  } catch (e) {
    throw new AiError(e.name === 'AbortError' ? 'timeout' : 'unavailable', String(e));
  } finally {
    clearTimeout(timer);
  }
  if (res.status === 502) throw new AiError('parse_failed', 'AI 输出无法解析');
  if (res.status === 504) throw new AiError('timeout', 'AI 响应超时');
  if (!res.ok) throw new AiError('unavailable', `Edge Function ${res.status}`);
  const data = await res.json();
  if (!data.ok || !data.result) throw new AiError('parse_failed', 'Edge Function 返回异常');
  return data.result;
}

// 白名单过滤：AI 返回的 intake 必须能在应服清单中按 (supplement, slot) 命中，
// 否则丢弃（防模型编造补剂名写库）；dose 一律取清单快照，不信 AI 的。
export function filterIntakeToChecklist(intake, checklist) {
  if (!Array.isArray(intake)) return [];
  const out = [];
  for (const item of intake) {
    const hit = checklist.find(
      (c) => c.supplement === item.supplement && c.slot === item.slot
    );
    if (hit) out.push({ supplement: hit.supplement, slot: hit.slot, dose: hit.dose, taken: !!item.taken });
  }
  return out;
}

// 规整 symptoms：缺 severity 给 2，限定 1-3（"无"不再是选项，没记录就是无）
export function sanitizeSymptoms(symptoms, fixedSymptoms) {
  if (!Array.isArray(symptoms)) return [];
  return symptoms
    .filter((s) => s && typeof s.symptom === 'string' && s.symptom.trim())
    .map((s) => ({
      symptom: s.symptom.trim(),
      severity: Number.isInteger(s.severity) && s.severity >= 1 && s.severity <= 3 ? s.severity : 2,
      is_custom: !fixedSymptoms.includes(s.symptom.trim()),
    }));
}

export const CYCLE_EVENTS = ['period_start', 'period_end', 'pms_start', 'jelly', 'bleed_light', 'bleed_heavy'];

// 规整 cycle：只接受合法事件名 + YYYY-MM-DD；支持单个或数组（补记多天），去重限量
export function sanitizeCycles(cycle) {
  const list = Array.isArray(cycle) ? cycle : cycle ? [cycle] : [];
  const seen = new Set();
  const out = [];
  for (const c of list) {
    if (!c || typeof c !== 'object') continue;
    if (!CYCLE_EVENTS.includes(c.event)) continue;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(c.date || '')) continue;
    const key = `${c.event}|${c.date}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ event: c.event, date: c.date });
    if (out.length >= 14) break;
  }
  return out;
}

// 规整 remove（撤销/删除指令）：只接受白名单动作
export function sanitizeRemove(remove) {
  if (!remove || typeof remove !== 'object') return null;
  if (['last', 'cycle_today', 'symptoms_today'].includes(remove.what)) {
    return { what: remove.what };
  }
  return null;
}
