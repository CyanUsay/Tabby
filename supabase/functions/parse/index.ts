// Tabby · DeepSeek 解析代理（Supabase Edge Function）
// 全项目唯一安全关键点：DEEPSEEK_API_KEY 只存在于这里的 secret，绝不下发前端。
// 部署：supabase secrets set DEEPSEEK_API_KEY=sk-xxx && supabase functions deploy parse --no-verify-jwt
// verify_jwt 关闭（见 supabase/config.toml）：新版 sb_publishable_ key 不是 JWT，过不了校验。

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const DEEPSEEK_URL = 'https://api.deepseek.com/chat/completions';

interface Context {
  date: string; // 由前端 appToday() 传入——服务器是 UTC，函数内绝不自取日期
  mode: 'daily' | 'pms' | 'period';
  checklist: Array<{ supplement: string; slot: string; dose: string }>;
  fixedSymptoms: string[];
}

// 注意：DeepSeek 的 json_object 模式硬性要求 prompt 中包含 "json" 字样，
// 修改此模板时不要删掉相关表述。
function buildSystemPrompt(ctx: Context): string {
  return `你是补剂追踪助手。今天是 ${ctx.date}，用户当前处于 ${ctx.mode} 模式。
今天的应服清单（supplement + slot + dose）如下：
${JSON.stringify(ctx.checklist, null, 0)}

已知固定症状标签：${ctx.fixedSymptoms.join('、')}

用户会用自然语言描述服用情况和身体状况。请解析为 JSON，严格只输出一个 JSON 对象，
不要 markdown，不要解释。结构：
{
  "intake": [ {"supplement":"VC","slot":"lunch","taken":true}, ... ],
  "symptoms": [ {"symptom":"胸胀","severity":2,"is_custom":false}, ... ],
  "cycle": null 或 {"event":"period_start","date":"YYYY-MM-DD"},
  "clarify": null 或 "需要向用户澄清的问题"
}

规则：
- "今天都吃了" → 应服清单全部 taken=true
- "漏了X / 没吃X" → 除 X 外全部 taken=true，X 为 taken=false
- "只吃了X" → 仅 X taken=true，其余 false
- intake 里的 supplement 和 slot 必须严格取自应服清单，不得编造
- 只提到症状不影响 intake；只提到 intake 不动 symptoms
- 症状不在固定标签里 → is_custom=true
- 程度词（"有点"→1，默认→2，"很/特别严重"→3）；无法判断填 2
- 识别到经期边界表达填 cycle，否则 null：
  · "来例假了/来了" → {"event":"period_start","date":"${ctx.date}"}
  · "结束了/走了" → {"event":"period_end","date":"${ctx.date}"}
  · "经期第N天" → period_start，date = ${ctx.date} 往前数 N-1 天（你来计算具体日期）
- 信息矛盾或无法确定时，intake/symptoms 留空，在 clarify 里写要问的话`;
}

function isValidResult(r: unknown): boolean {
  if (typeof r !== 'object' || r === null) return false;
  const o = r as Record<string, unknown>;
  return (
    'intake' in o && 'symptoms' in o && 'cycle' in o && 'clarify' in o &&
    Array.isArray(o.intake) && Array.isArray(o.symptoms)
  );
}

async function callDeepSeek(apiKey: string, system: string, userText: string) {
  const res = await fetch(DEEPSEEK_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: 'deepseek-chat',
      response_format: { type: 'json_object' },
      temperature: 0, // 结构化抽取要确定性
      max_tokens: 1500, // json mode 下 token 不足会截断/返回空 content，给足余量
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: userText },
      ],
    }),
    signal: AbortSignal.timeout(25_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw Object.assign(new Error(`DeepSeek ${res.status}: ${body}`), { status: res.status });
  }
  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content ?? '';
  const parsed = JSON.parse(content); // 失败抛 SyntaxError，由上层重试
  if (!isValidResult(parsed)) throw new SyntaxError('missing required keys');
  return parsed;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json(405, { ok: false, error: 'method_not_allowed' });

  const apiKey = Deno.env.get('DEEPSEEK_API_KEY');
  if (!apiKey) return json(500, { ok: false, error: 'missing_api_key' });

  let userText: string, context: Context;
  try {
    const body = await req.json();
    userText = String(body.userText ?? '').trim();
    context = body.context;
    if (!userText || !context?.date || !context?.mode || !Array.isArray(context?.checklist)) {
      return json(400, { ok: false, error: 'bad_request' });
    }
  } catch {
    return json(400, { ok: false, error: 'bad_request' });
  }

  const system = buildSystemPrompt(context);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const result = await callDeepSeek(apiKey, system, userText);
      return json(200, { ok: true, result });
    } catch (e) {
      const status = (e as { status?: number }).status;
      if (status === 429 || status === 402) {
        return json(status, { ok: false, error: status === 429 ? 'rate_limited' : 'insufficient_balance' });
      }
      if ((e as Error).name === 'TimeoutError') {
        return json(504, { ok: false, error: 'deepseek_timeout' });
      }
      // JSON 解析失败/缺键 → 重试一次
      if (e instanceof SyntaxError && attempt === 0) continue;
      console.error('parse failed:', e);
      return json(502, { ok: false, error: 'parse_failed' });
    }
  }
  return json(502, { ok: false, error: 'parse_failed' });
});
