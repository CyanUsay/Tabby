// 症状区：固定标签胶囊 chip + 自定义输入；点 chip 弹程度选择。
// 程度只有 轻/中/重（1-3），没记录就是"无"；颜色从轻到重渐变。
// 注：数据库没有 delete 权限，"清除"= 把 severity 写成 0（展示上等同未记录）。

const SEVERITY_LABELS = ['无', '轻', '中', '重'];

export function severityLabel(n) {
  return SEVERITY_LABELS[n] ?? '中';
}

// els: {chipsEl, pickerEl, input, addBtn}
// todaySymptoms: [{symptom, severity, is_custom}]
// onLog(symptom, severity, isCustom) → Promise
export function renderSymptoms(els, fixedSymptoms, todaySymptoms, onLog) {
  const { chipsEl, pickerEl, input, addBtn } = els;
  const logged = new Map(
    todaySymptoms.filter((s) => s.severity > 0).map((s) => [s.symptom, s])
  );

  chipsEl.innerHTML = '';
  const names = [...fixedSymptoms];
  for (const s of logged.values()) {
    if (!names.includes(s.symptom)) names.push(s.symptom); // 今天记过的临时症状也显示
  }
  for (const name of names) {
    const rec = logged.get(name);
    const chip = document.createElement('button');
    chip.className = rec ? `chip active sev-${rec.severity}` : 'chip';
    chip.textContent = rec ? `${name} · ${severityLabel(rec.severity)}` : name;
    chip.addEventListener('click', () =>
      openPicker(pickerEl, name, !fixedSymptoms.includes(name), !!rec, onLog)
    );
    chipsEl.appendChild(chip);
  }

  addBtn.onclick = () => {
    const name = input.value.trim();
    if (!name) return;
    input.value = '';
    openPicker(pickerEl, name, !fixedSymptoms.includes(name), false, onLog);
  };
}

function openPicker(pickerEl, symptom, isCustom, isLogged, onLog) {
  pickerEl.innerHTML = '';
  const box = document.createElement('div');
  box.className = 'severity-picker';
  const label = document.createElement('div');
  label.className = 'label';
  label.textContent = `「${symptom}」程度？`;
  const options = document.createElement('div');
  options.className = 'options';
  for (const severity of [1, 2, 3]) {
    const btn = document.createElement('button');
    btn.className = `sev-${severity}`;
    btn.textContent = SEVERITY_LABELS[severity];
    btn.addEventListener('click', async () => {
      pickerEl.innerHTML = '';
      await onLog(symptom, severity, isCustom);
    });
    options.appendChild(btn);
  }
  if (isLogged) {
    const clear = document.createElement('button');
    clear.textContent = '清除';
    clear.className = 'danger';
    clear.addEventListener('click', async () => {
      pickerEl.innerHTML = '';
      await onLog(symptom, 0, isCustom);
    });
    options.appendChild(clear);
  }
  const cancel = document.createElement('button');
  cancel.textContent = '算了';
  cancel.className = 'danger';
  cancel.addEventListener('click', () => (pickerEl.innerHTML = ''));
  options.appendChild(cancel);
  box.append(label, options);
  pickerEl.appendChild(box);
}
