-- Tabby · 0002：周期事件改为"观察事实"词汇
-- （由 deploy workflow 自动应用；手动跑则在 SQL Editor 整体执行一次）
--
-- 设计：只存观察到的事实，状态由前端推算器对全部历史推导，支持回溯修正。
--   jelly        果冻状分泌物（排卵信号）
--   bleed_light  少量出血（孤立出现时解读为不正出血）
--   bleed_heavy  经期血量出血（与紧邻的 bleed_light 合并成经期段，Day1 回溯到段首）
--   period_start 旧数据兼容（推算器视同 bleed_heavy）
--   period_end   口头报告经期结束
--   pms_start    进入 PMS（口头或症状触发确认）

alter table cycle_event drop constraint cycle_event_event_check;
alter table cycle_event add constraint cycle_event_event_check
  check (event in ('period_start', 'period_end', 'pms_start', 'jelly', 'bleed_light', 'bleed_heavy'));
