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
  cycleEvents?: Array<{ event: string; date: string }>; // 最近的周期记录（删除指令定位用）
}

// 注意：DeepSeek 的 json_object 模式硬性要求 prompt 中包含 "json" 字样，
// 修改此模板时不要删掉相关表述。
function buildSystemPrompt(ctx: Context): string {
  return `你是补剂追踪助手。今天是 ${ctx.date}，用户当前处于 ${ctx.mode} 模式。
今天的应服清单（supplement + slot + dose）如下：
${JSON.stringify(ctx.checklist, null, 0)}

已知固定症状标签：${ctx.fixedSymptoms.join('、')}

数据库里最近的周期记录（日期 事件）：
${(ctx.cycleEvents ?? []).map((e) => `${e.date} ${e.event}`).join('、') || '（暂无记录）'}

用户会用自然语言描述服用情况和身体状况。请解析为 JSON，严格只输出一个 JSON 对象，
不要 markdown，不要解释。结构：
{
  "intake": [ {"supplement":"VC","slot":"lunch","taken":true}, ... ],
  "symptoms": [ {"symptom":"胸胀","severity":2,"is_custom":false}, ... ],
  "cycle": null 或 {"event":"...","date":"YYYY-MM-DD"} 或 多天补记时的数组 [{...},{...}],
  "remove": null 或 {"what":"last"|"cycle_today"|"symptoms_today"},
  "clarify": null 或 "需要向用户澄清的问题"
}

规则：
- 用户随时可能只说一部分，intake 只输出明确提到的范围，绝不要把没提到的条目也填上：
  · "晚饭的吃了/晚饭后那些吃了" → 只输出 dinner slot 的条目 taken=true
  · "刚吃了镁/吃了VC" → 只输出对应补剂的条目 taken=true（同名多时段时取当前最近的时段）
  · "今天都吃了" → 才输出全部清单 taken=true
  · "漏了X / 没吃X"（在"都吃了"语境下）→ 除 X 外全部 taken=true，X 为 taken=false
  · "X没吃" 单说 → 只输出 X taken=false
- intake 里的 supplement 和 slot 必须严格取自应服清单，不得编造
- 只提到症状不影响 intake；只提到 intake 不动 symptoms
- 失眠/噩梦/吓醒/睡不好/半夜醒 → 统一记 symptom "睡眠障碍"
- 症状不在固定标签里 → is_custom=true
- severity 取值 1-3（"有点"→1，默认→2，"很/特别严重"→3）；无法判断填 2
- 撤销/删除表达填 remove，否则 null：
  · "刚刚那条删掉/撤销/记错了删掉" → {"what":"last"}
  · 删周期记录的【默认形态】（"删除pms/把9号的出血删掉/删除从前天开始的月经/整个经期删掉"）
    → {"what":"cycle_events","items":[{"event":"...","date":"YYYY-MM-DD"},...]}
      items 必须从上面"数据库里最近的周期记录"中挑选真实存在的条目逐条列出，
      日期以记录里的为准（"删除pms"= 找到 pms_start 那条，哪怕它是几天前记的）；
      "整个经期"= 该段的 period_start/bleed_heavy/bleed_light/period_end 条目，
      jelly、pms_start、not_period 不属于经期记录，用户点名才删；
      对不上号才用 clarify 问，能对上就直接给 items 不要反问
  · 仅当用户明确点名"今天"（"把今天的周期记录删了/搞错了，今天不是经期"）
    → {"what":"cycle_today"}
  · "把今天记的症状都删了" → {"what":"symptoms_today"}
  · 纯删除指令时 cycle 必须为 null——绝不要把要删的条目再写进 cycle（又删又记等于没删）
  · 只有用户当前这句话明确表达删除/撤销/纠错时才填 remove；单纯描述身体状况
    （出血/流血/果冻/经期开始等）永远是记录 cycle、remove=null——
    哪怕上一轮对话刚执行过删除，也绝不延续删除意图
- 补记多天：用户可能一次报多天，cycle 用数组逐天生成：
  · "9号和10号都有少量出血" → 两条 bleed_light（date 取今天所在月份的 9 日与 10 日；若该日期晚于今天则取上个月）
  · "昨天" = ${ctx.date} 减 1 天；"前天" = 减 2 天；"这两天有果冻" = 昨天和今天各一条 jelly
  · "连续三天有果冻" = 今天往前数三天各一条 jelly
  · "从前天开始流血/出血"（"开始"=持续至今）= 前天、昨天、今天逐日各一条 bleed_light
    （明确说量大才用 bleed_heavy）
- 结合对话上文理解省略回答：若上一轮你在澄清（如问"哪几天"），用户的简短回答
  （"都有"/"是的"/"昨天"）要按上文补全成完整含义，再生成对应记录；
  绝不要把这类回答误解析成补剂打卡
- 识别到周期观察/事件表达填 cycle（event 只能取下列几种），否则 null：
  · "来例假了/月经来了/大姨妈来了/经期开始了"（亲口宣告这是经期）→ {"event":"period_start","date":"${ctx.date}"}
  · "血量是经期的量/量多了/出血变多"（只描述血量，没说是月经）→ {"event":"bleed_heavy","date":"${ctx.date}"}
  · "有点血/见红/少量出血"（少量、不确定是不是经期）→ {"event":"bleed_light","date":"${ctx.date}"}
  · "果冻状分泌物/蛋清状分泌物/拉丝白带" → {"event":"jelly","date":"${ctx.date}"}
  · "PMS开始了/进入PMS了/经前期来了" → {"event":"pms_start","date":"${ctx.date}"}（注意：这不是经期！）
  · "（经期）结束了/走了" → {"event":"period_end","date":"${ctx.date}"}
  · "这不是月经/不是例假/不是大姨妈"（否认某次出血是经期）→ {"event":"not_period","date":"${ctx.date}"}
  · "经期第N天" → period_start，date = ${ctx.date} 往前数 N-1 天（你来计算具体日期）
- 区分要点：亲口说"例假/月经/大姨妈来了"是宣告 → period_start；只描述血量像经期/量大 → bleed_heavy；
  只说"有点血" → bleed_light，不要拔高
- 信息矛盾或无法确定时，intake/symptoms 留空，在 clarify 里写要问的话
- clarify 的语气：你是用户的猫咪助手，称呼用户为"主人"，句尾带"喵"，
  语气可爱，可以带猫咪颜文字（如 ฅ(•ㅅ•)ฅ、(=^･ω･^=)），但问题本身要清楚具体`;
}

// 宽容规整：模型偶尔省略值为 null/[] 的键（尤其 remove-only 的回答），
// 缺什么补什么，只要整体是个对象就接受。前端还有一道白名单兜底。
function normalizeResult(r: unknown): Record<string, unknown> {
  if (typeof r !== 'object' || r === null || Array.isArray(r)) {
    throw new SyntaxError('not an object');
  }
  const o = r as Record<string, unknown>;
  return {
    intake: Array.isArray(o.intake) ? o.intake : [],
    symptoms: Array.isArray(o.symptoms) ? o.symptoms : [],
    cycle: o.cycle ?? null,
    remove: o.remove ?? null,
    clarify: typeof o.clarify === 'string' && o.clarify.trim() ? o.clarify : null,
  };
}

async function callDeepSeek(
  apiKey: string,
  system: string,
  userText: string,
  history: Array<{ role: string; content: string }>,
) {
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
        ...history,
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
  return normalizeResult(JSON.parse(content)); // 失败抛 SyntaxError，由上层重试
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
  let history: Array<{ role: string; content: string }> = [];
  try {
    const body = await req.json();
    userText = String(body.userText ?? '').trim();
    context = body.context;
    if (!userText || !context?.date || !context?.mode || !Array.isArray(context?.checklist)) {
      return json(400, { ok: false, error: 'bad_request' });
    }
    // 最近几轮对话：让"都有"这类省略回答能接上文
    if (Array.isArray(body.history)) {
      history = body.history
        .filter((m: { role?: string; content?: string }) =>
          (m?.role === 'user' || m?.role === 'assistant') && typeof m?.content === 'string')
        .slice(-6)
        .map((m: { role: string; content: string }) => ({ role: m.role, content: m.content.slice(0, 400) }));
    }
  } catch {
    return json(400, { ok: false, error: 'bad_request' });
  }

  const system = buildSystemPrompt(context);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const result = await callDeepSeek(apiKey, system, userText, history);
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
