// 症状区：固定标签胶囊 chip + 自定义输入；点 chip 弹 severity 选择。

const SEVERITY_LABELS = ['无', '轻', '中', '重'];

export function severityLabel(n) {
  return SEVERITY_LABELS[n] ?? '中';
}

// els: {chipsEl, pickerEl, input, addBtn}
// todaySymptoms: [{symptom, severity, is_custom}]
// onLog(symptom, severity, isCustom) → Promise
export function renderSymptoms(els, fixedSymptoms, todaySymptoms, onLog) {
  const { chipsEl, pickerEl, input, addBtn } = els;
  const logged = new Map(todaySymptoms.map((s) => [s.symptom, s]));

  chipsEl.innerHTML = '';
  const names = [...fixedSymptoms];
  for (const s of todaySymptoms) {
    if (!names.includes(s.symptom)) names.push(s.symptom); // 今天记过的临时症状也显示
  }
  for (const name of names) {
    const rec = logged.get(name);
    const chip = document.createElement('button');
    chip.className = `chip${rec ? ' active' : ''}`;
    chip.textContent = rec ? `${name} · ${severityLabel(rec.severity)}` : name;
    chip.addEventListener('click', () =>
      openPicker(pickerEl, name, !fixedSymptoms.includes(name), onLog)
    );
    chipsEl.appendChild(chip);
  }

  addBtn.onclick = () => {
    const name = input.value.trim();
    if (!name) return;
    input.value = '';
    openPicker(pickerEl, name, !fixedSymptoms.includes(name), onLog);
  };
}

function openPicker(pickerEl, symptom, isCustom, onLog) {
  pickerEl.innerHTML = '';
  const box = document.createElement('div');
  box.className = 'severity-picker';
  const label = document.createElement('div');
  label.className = 'label';
  label.textContent = `「${symptom}」程度？`;
  const options = document.createElement('div');
  options.className = 'options';
  SEVERITY_LABELS.forEach((text, severity) => {
    const btn = document.createElement('button');
    btn.textContent = text;
    btn.addEventListener('click', async () => {
      pickerEl.innerHTML = '';
      await onLog(symptom, severity, isCustom);
    });
    options.appendChild(btn);
  });
  const cancel = document.createElement('button');
  cancel.textContent = '取消';
  cancel.className = 'danger';
  cancel.addEventListener('click', () => (pickerEl.innerHTML = ''));
  options.appendChild(cancel);
  box.append(label, options);
  pickerEl.appendChild(box);
}
