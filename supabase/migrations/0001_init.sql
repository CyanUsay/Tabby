-- Tabby · 初始建表 + RLS
-- 在 Supabase SQL Editor 中整体执行一次。

-- 1. 每日补剂服用记录
create table if not exists intake_log (
  id uuid primary key default gen_random_uuid(),
  date date not null,
  supplement text not null,
  slot text not null check (slot in ('wake', 'lunch', 'dinner', 'bedtime')),
  dose text,
  taken boolean not null default false,
  mode text not null check (mode in ('daily', 'pms', 'period')),
  updated_at timestamptz not null default now(),
  unique (date, supplement, slot)
);

-- 2. 症状记录（同一天同一症状只保留一条，重复上报走 upsert 更新 severity）
create table if not exists symptom_log (
  id uuid primary key default gen_random_uuid(),
  date date not null,
  symptom text not null,
  severity int not null default 2 check (severity between 0 and 3),
  is_custom boolean not null default false,
  note text,
  created_at timestamptz not null default now(),
  unique (date, symptom)
);

-- 3. 经期事件（状态机的事实来源）
create table if not exists cycle_event (
  id uuid primary key default gen_random_uuid(),
  event text not null check (event in ('period_start', 'period_end')),
  date date not null,
  created_at timestamptz not null default now(),
  unique (event, date)
);

-- 4. 症状标签字典
create table if not exists symptom_catalog (
  name text primary key,
  is_fixed boolean not null default false,
  first_seen date default current_date,
  count int not null default 0
);

-- RLS：开启 + anon 显式 select/insert/update。
-- 故意不开 delete：anon key 即使泄露也只能写脏数据、不能清库；删除/纠错走 dashboard。
-- 注意：PostgREST upsert 冲突时走 update 路径，insert 与 update 策略必须成对存在。

alter table intake_log enable row level security;
create policy anon_select on intake_log for select to anon using (true);
create policy anon_insert on intake_log for insert to anon with check (true);
create policy anon_update on intake_log for update to anon using (true);

alter table symptom_log enable row level security;
create policy anon_select on symptom_log for select to anon using (true);
create policy anon_insert on symptom_log for insert to anon with check (true);
create policy anon_update on symptom_log for update to anon using (true);

alter table cycle_event enable row level security;
create policy anon_select on cycle_event for select to anon using (true);
create policy anon_insert on cycle_event for insert to anon with check (true);
create policy anon_update on cycle_event for update to anon using (true);

alter table symptom_catalog enable row level security;
create policy anon_select on symptom_catalog for select to anon using (true);
create policy anon_insert on symptom_catalog for insert to anon with check (true);
create policy anon_update on symptom_catalog for update to anon using (true);
