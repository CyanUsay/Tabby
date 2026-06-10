// Tabby 配置 —— 这是唯一需要你填值的文件（见 SETUP.md）。

// Supabase 项目设置 → API 页面里的 Project URL 与 publishable key。
// publishable key 设计上可以公开（它只有 RLS 允许的权限）。
export const SUPABASE_URL = 'https://hsppianjfrwryhutplry.supabase.co';
export const SUPABASE_ANON_KEY = 'sb_publishable_KsENhwHRhxx8rSB-juwR7g_rBKNeKcK';

// Edge Function 地址：https://<project-ref>.supabase.co/functions/v1/parse
export const PARSE_FN_URL = 'https://hsppianjfrwryhutplry.supabase.co/functions/v1/parse';

// 经期状态机参数（按自己实际情况调整）
export const cycleConfig = {
  periodLength: 5, // 没显式记录"结束"时，经期默认持续天数
  pmsMaxDays: 14, // 报告"PMS开始"后最长持续天数（兜底，防止忘记报经期）
};

// "今天"的边界：凌晨 0 点到此小时之间算前一天（DSPS 作息友好）
export const DAY_CUTOFF_HOUR = 5;
