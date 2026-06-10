# Tabby 部署清单

从零到 iPhone 主屏幕，按顺序做完即可。**1～4 步做完才算上线**，第 5 步起是锦上添花。

## 1. Supabase（数据库）

1. 在 [supabase.com](https://supabase.com) 新建项目，**区域选 Tokyo 或 Singapore**（离你近、延迟低）。
2. 进 **SQL Editor**，依次整段执行：
   - `supabase/migrations/0001_init.sql`（建表 + RLS）
   - `supabase/seed.sql`（症状字典）
3. 进 **Settings → API**，记下两个值：
   - Project URL（形如 `https://abcdefgh.supabase.co`）
   - publishable key（`sb_publishable_` 开头；老项目则是 anon key。设计上可公开）

## 2. DeepSeek（AI）

1. 在 [platform.deepseek.com](https://platform.deepseek.com) 注册并充值（10 元能用很久）。
2. 创建 API key（`sk-` 开头），下一步要用。

## 3. Edge Function（API key 代理，必须做）

DeepSeek key 绝不能放前端。在本机装好 [Supabase CLI](https://supabase.com/docs/guides/cli) 后，在仓库根目录执行：

```bash
supabase login
supabase link --project-ref <你的项目ref>     # ref 是 Project URL 里的子域名
supabase secrets set DEEPSEEK_API_KEY=sk-xxx
supabase functions deploy parse --no-verify-jwt
```

> `--no-verify-jwt` 是必须的：新版 `sb_publishable_` key 不是 JWT，过不了默认校验。

冒烟测试（替换项目 ref）：

```bash
curl -s 'https://<项目ref>.supabase.co/functions/v1/parse' \
  -H 'Content-Type: application/json' \
  -d '{
    "userText": "今天都吃了，漏了VC，有点胸胀",
    "context": {
      "date": "2026-06-10",
      "mode": "daily",
      "checklist": [
        {"supplement":"VC","slot":"lunch","dose":"500 mg"},
        {"supplement":"VD","slot":"lunch","dose":"5000 IU"}
      ],
      "fixedSymptoms": ["胸胀","情绪低落"]
    }
  }'
```

预期返回 `{"ok":true,"result":{"intake":[...],"symptoms":[...],...}}`，
其中 VC 是 `taken:false`、VD 是 `taken:true`、胸胀 severity 1。

## 4. 前端配置 + GitHub Pages

1. 编辑 `js/config.js`，填三个值：`SUPABASE_URL`、`SUPABASE_ANON_KEY`（publishable key）、
   `PARSE_FN_URL`（= `https://<项目ref>.supabase.co/functions/v1/parse`）。✅ 已填好。
2. 把代码合到 **main 分支**（Pages 从 main 部署，feature 分支不会生效）。
3. 仓库 Settings → Pages → Source 选 **Deploy from a branch** → `main` / `/ (root)`。
4. 等一两分钟，访问 `https://<你的用户名>.github.io/Tabby/` 验证：
   - 清单能勾选，刷新后保留（说明 Supabase 链路通）
   - 聊天框说"今天都吃了"，出预览卡，确认后清单变绿（说明 AI 链路通）

## 5. iPhone 安装成"app"

Safari 打开站点 → 分享按钮 → **添加到主屏幕**。之后从主屏幕图标打开就是全屏独立 app，
没有地址栏；前端代码更新后无需重装，重新打开即拉到新版。

## 6. 自动备份（每周）

仓库 Settings → Secrets and variables → Actions，添加两个 secret：

| 名称 | 值 |
|---|---|
| `SUPABASE_URL` | Project URL |
| `SUPABASE_ANON_KEY` | publishable key（`sb_publishable_` 开头） |

之后每周一凌晨 5 点（UTC+8）自动把四张表导出为 JSON 提交到 `backups/`。
也可以在 Actions 页面手动点 Run workflow 立即验证一次。

## 7. 自动部署（配好后再也不用手动跑 SQL / 贴函数代码）

仓库 Settings → Secrets and variables → Actions，再加两个 secret：

| 名称 | 值 | 在哪拿 |
|---|---|---|
| `SUPABASE_ACCESS_TOKEN` | `sbp_` 开头的令牌 | dashboard 右上角头像 → Account Settings → Access Tokens → Generate new token |
| `SUPABASE_DB_PASSWORD` | 数据库密码 | 建项目时设置的那个；忘了去 Settings → Database 重置 |

之后每次合并进 main：Pages 自动发前端，`deploy` workflow 自动应用新迁移 + 重部署 Edge Function。
也可在 Actions 页对 `deploy` 手动 Run workflow。

## 日常维护

- **改了任何前端文件**（html/css/js）→ 把 `sw.js` 顶部的 `tabby-shell-v1` 版本号 +1 再 push，
  否则 iPhone 上的缓存不会更新。
- **改补剂方案** → `js/protocol.js`；**改周期参数/day cutoff** → `js/config.js`。
- **删错误数据** → Supabase dashboard 的 Table Editor（前端故意没有删除权限，
  anon key 即使泄露也只能写不能删）。
- **本地预览** → `python3 -m http.server 8000` 后访问 `http://localhost:8000/?mock=1`
  （mock 模式全部数据在内存，绝不碰真实数据库）。
- **跑测试** → `node test/run-tests.mjs`（纯函数断言，零网络）。
