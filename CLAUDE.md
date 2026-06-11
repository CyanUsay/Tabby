# Tabby 项目交接备忘（给下一个 Claude 窗口）

> 单人私用的补剂/经期/症状追踪 PWA，用户在 iPhone 上以主屏幕 app 使用。
> 代码自身已有较多注释，本文件只写**代码里看不出来的**约定、事实和坑。

## 用户与产品性格

- 用户是唯一使用者，中文交流。Tabby 对用户的人设是**猫娘**：称"主人"、句尾"喵"、
  带猫咪颜文字——所有 UI 反馈语和 AI clarify 都要维持这个口吻，新增文案别写成普通腔。
- 用户对视觉**非常**讲究，迭代方式是小步快改：她发截图指出问题 → 改 → 上线 → 她验收。
  改完一定截图发给她（playwright 390 或 375 宽，deviceScaleFactor 2）。
- 设计语言：弥散渐变背景（杏花粉→碧落蓝）+ 磨砂玻璃块面；品牌粉 `#D6809A` 体系管交互
  状态；四时段色（睡醒粉 #E88AA0/午橙 #F0A95C/晚紫 #9D8FE0/睡前蓝 #7EB3E8）管归属；
  经期红 `#D6283B` 是唯一高饱和信号色。完整色卡在代码里：基础变量在
  `css/style.css` 顶部 `:root`（暗色变体在 `.dark`），四时段色定义在 `js/checklist.js`。

## 基础设施（手动配好的部分）

- Supabase 项目 ref：`hsppianjfrwryhutplry`。前端用的是新版 **publishable key**
  （`sb_publishable_` 开头，已明文写在 `js/config.js`，设计上可公开）。
- ⚠️ 新版 publishable key **不是 JWT**：PostgREST 只放 `apikey` 头（不要加
  Authorization Bearer）；Edge Function 必须关 JWT 校验（`supabase/config.toml`
  + 部署加 `--no-verify-jwt`），否则 401。
- DeepSeek key 存在 Supabase secrets，名 `DEEPSEEK_API_KEY`，模型 `deepseek-chat`。
- GitHub repo secrets 已配：`SUPABASE_ACCESS_TOKEN`、`SUPABASE_DB_PASSWORD`、
  `SUPABASE_URL`、`SUPABASE_ANON_KEY`。
- 线上地址 https://cyanusay.github.io/Tabby/（Pages 从 main 根目录发布）。

## 开发与上线流程（已与用户约定）

1. 在当次会话指定的 `claude/*` 分支上开发（每个 session 的分支名不同，别在这里写死）。
2. 本地验证（见下节）全过后 → push 分支 → **合并进 main 并 push**（用户已授权
   这个流程，session 后期都是改完直接合并，合并后发截图给她验收）。
3. 合并 main 自动触发：Pages 发前端；`deploy.yml`（仅 supabase/** 变更时）自动
   `db push` 应用新迁移 + 重新部署 parse 函数。**任何环节都不需要用户手动操作**。
4. `backup.yml` 每周一 5 点（UTC+8）备份四张表 JSON 到 `backups/` 并提交 main——
   所以 **push main 前先 pull**（backup 提交常让本地 main 落后，fast-forward 会失败，
   直接普通 merge 即可）。

## 铁律

- **改任何前端文件必须 bump `sw.js` 顶部缓存版本号**（以文件实际值为准，只增不减）。前端已有
  自动更新（controllerchange → reload），用户打开 app 即拿新版，无需重装。
- **测试绝不碰真实数据库**：`node test/run-tests.mjs`（纯函数，不依赖网络）；
  UI 用 `python3 -m http.server 8123` + `http://localhost:8123/?mock=1`
  （mock 全内存）。playwright 在 `/opt/node22/lib/node_modules/playwright`，
  容器重启后需重装 chromium：`npx playwright install chromium --with-deps`。
- 真实函数冒烟：直接 `curl -X POST https://<ref>.supabase.co/functions/v1/parse`
  （无需任何 auth 头）。本容器能直连 Supabase 与 DeepSeek。
- 无认证 GitHub API 限流 60 次/小时，查 workflow 状态优先用 GitHub MCP 工具；
  等 Pages 发布用后台 until 循环 grep sw.js 版本号。
- PostgREST 查询参数里的**中文必须 URL 编码**，否则静默匹配 0 行（踩过坑）。
- DeepSeek `json_object` 模式：prompt 必须含 "json" 字样；模型回答 remove-only
  时会省略其他键，函数里 `normalizeResult` 已做宽容补全——改 prompt 别破坏这两点。

## 数据模型心智（最重要的设计决策）

- **记录与判断分离**：`cycle_event` 只存观察事实（jelly / bleed_light /
  bleed_heavy / period_end / pms_start；period_start 为旧数据兼容=heavy），
  状态由 `js/cycle.js` 的 `deriveState` 对全部历史推算，**新观察自动回溯修正旧解读**
  （如出血段并入经期、Day1 回溯）。永远不要直接"改写"历史判断，改观察即可。
- 用户经期不规律，**一切预测不可靠**，唯一可靠预估 = 排卵日 + 黄体期 14 天。
- RLS：intake_log 无 delete（取消打卡=taken false）；cycle_event/symptom_log
  有 delete（0003 起，支持聊天撤销指令）；symptom"清除"= 真删除行。
- 聊天解析带最近 6 条对话上下文（修复"都有"被误判的 bug），cycle 可为数组（多天补记）。

## 用户身体相关的已定参数（别擅自改）

- day cutoff **早上 5:00**（用户 DSPS 作息，凌晨算前一天）。
- periodLength 5 / pmsMaxDays 14 / bleedGapDays 1（出血断档≤1天算同段）/
  lutealDays 14 / 黄体期上限 16 天。
- 状态四分类：正常 / 排卵期（连续≥2天果冻段内）/ 黄体期（段束**立刻**开始）/
  经期 Day X；PMS 显示优先级高于排卵/黄体。
- PMS 标记症状（触发"要进入PMS模式吗"询问）：胸胀、情绪低落、睡眠障碍。
- 失眠/噩梦/吓醒统一归并"睡眠障碍"（"噩梦"标签已降级非固定）。

## 已知遗留与 v2 候选

- `intake_log` 里有一行 2000-01-01 的 `__连通性测试__`（无害，用户知道）。
- iOS 网页无震动 API，长按反馈靠盖章动画（已和用户解释过）。
- GH Pages CDN 对 sw.js 有最长 10 分钟缓存，刚发布就让用户验可能拿到旧版，稍等。
- v2 候选（用户提过没做）：趋势图（VD→精力、镁/B6→PMS强度对照）、临时症状反复
  出现提示转固定标签、多人模式（"瑶"）。
- 原始需求 spec 是首次会话上传的 supplementtrackerspec.md，**不在仓库里**、后续
  窗口看不到（核心内容已演化，以现状代码为准；AI 只翻译不决定、落库必经预览确认
  这条**永远不变**）。
