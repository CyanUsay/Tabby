-- Tabby · 0003：睡眠障碍标签归并 + 撤销/删除支持
-- （由 deploy workflow 自动应用）

-- 失眠/噩梦/吓醒等统一归并为"睡眠障碍"（旧的"噩梦"标签降为非固定，历史数据保留）
insert into symptom_catalog (name, is_fixed) values ('睡眠障碍', true)
on conflict (name) do update set is_fixed = true;
update symptom_catalog set is_fixed = false where name = '噩梦';

-- 支持聊天指令"刚刚那条删掉/今天不是经期/把今天的症状删了"：
-- 给 cycle_event 与 symptom_log 开 anon delete（单人应用，每周自动备份兜底）。
-- intake_log 仍不开 delete——取消打卡用 taken=false 即可。
create policy anon_delete on cycle_event for delete to anon using (true);
create policy anon_delete on symptom_log for delete to anon using (true);
