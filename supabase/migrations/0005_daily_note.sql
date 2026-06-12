-- Tabby · 0005：每日备注笔记
-- （由 deploy workflow 自动应用；手动跑则在 SQL Editor 整体执行一次）
-- 记录页"当日记录"卡里的自由备注栏，一天一条。

create table if not exists daily_note (
  date date primary key,
  body text not null default '',
  updated_at timestamptz not null default now()
);

alter table daily_note enable row level security;
create policy anon_select on daily_note for select to anon using (true);
create policy anon_insert on daily_note for insert to anon with check (true);
create policy anon_update on daily_note for update to anon using (true);
create policy anon_delete on daily_note for delete to anon using (true);
