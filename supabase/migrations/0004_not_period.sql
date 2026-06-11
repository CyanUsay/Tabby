-- Tabby · 0004：三层判经期规则配套
-- （由 deploy workflow 自动应用；手动跑则在 SQL Editor 整体执行一次）
--
-- 词汇变化：
--   period_start 语义回归"亲口宣告经期开始"（第一层判定的最强信号；
--                旧数据本来就是"来例假了"的宣告，语义恰好兼容）
--   not_period   新增：亲口否认"这不是月经"（把所在出血段钉死为孤立出血）

alter table cycle_event drop constraint cycle_event_event_check;
alter table cycle_event add constraint cycle_event_event_check
  check (event in ('period_start', 'period_end', 'pms_start', 'jelly', 'bleed_light', 'bleed_heavy', 'not_period'));
