-- Tabby · 症状字典 seed（固定标签进趋势维度）
insert into symptom_catalog (name, is_fixed) values
  ('胸胀', true),
  ('噩梦', true),
  ('情绪低落', true),
  ('精力', true),
  ('头痛', true),
  ('腹痛', true),
  ('发热感', true)
on conflict (name) do nothing;
