-- Tabby · 0002：扩展周期事件类型
-- 在 Supabase SQL Editor 中整体执行一次。
-- 新增：pms_start（手动报告 PMS 开始）、spotting（突破性出血）、ovulation_sign（排卵信号，如蛋清状分泌物）

alter table cycle_event drop constraint cycle_event_event_check;
alter table cycle_event add constraint cycle_event_event_check
  check (event in ('period_start', 'period_end', 'pms_start', 'spotting', 'ovulation_sign'));
