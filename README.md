# Tabby 🐱

自然语言驱动的补剂 / 经期 / 症状追踪器。名字双关 tablet（药片）和虎斑猫。

跟它说一句"今天都吃了""漏了VC""今天胸胀情绪低落"，AI 解析成结构化数据，
你瞄一眼预览卡点个确认，就记好了。

## 架构

```
iPhone PWA（GitHub Pages 静态托管）
   │
   ├── Supabase PostgREST ←─ 补剂/症状/经期数据（anon key 直连，RLS 无 delete）
   │
   └── Supabase Edge Function（parse）─→ DeepSeek API（key 藏在 secret 里）
```

- **AI 只做翻译，不做决定**：解析结果必须经预览卡确认才落库。
- **经期状态机**：由 `cycle_event` 事件 + 日期自动推导 daily/pms/period 三模式，
  每天"应该吃哪些"随模式变化；用户的话只在周期边界时校正它。
- **手动兜底**：AI 挂了照样能点勾，所有写入路径不依赖 AI。
- **DSPS 友好**："今天"的边界是凌晨 5 点，不是午夜（`js/config.js` 可改）。
- **日夜双主题**：日间莫兰迪蓝配粉、夜间黑配粉，跟随系统亦可手动切换。

## 部署

见 [SETUP.md](SETUP.md)。

## 开发

```bash
node test/run-tests.mjs                # 纯函数测试（零网络、零数据库）
python3 -m http.server 8000            # 本地预览
# 浏览器开 http://localhost:8000/?mock=1  → mock 模式，数据在内存，不碰真实库
```

改前端后记得 bump `sw.js` 顶部缓存版本号。
