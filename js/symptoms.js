// 症状区交互：
//   点未选中的 tag → 直接按默认程度"中"记上（不打断）
//   点已选中的 tag → 展开程度面板（轻/中/重/清除）；再点一下 tag = 收起（算了）
// 程度色阶从轻到重渐变；"清除"= 删掉这条记录（没记录就等于"无"）。

const SEVERITY_LABELS = ['无', '轻', '中', '重'];
const DEFAULT_SEVERITY = 2;

export function severityLabel(n) {
  return SEVERITY_LABELS[n] ?? '中';
}

// 症状严重度三档（统计位 & PMS 色带浓度用）：
//   平稳 = 没记症状，或只记 1 项且程度为轻
//   轻   = 记 2~4 项且都是轻
//   明显 = 任何一项程度到"中"以上，或记了 ≥5 项（无论程度）
const LEVEL_LABELS = { calm: '平稳', mild: '轻', marked: '明显' };

export function severityLevel(symptoms) {
  const logged = (symptoms ?? []).filter((s) => s.severity > 0);
  if (logged.length >= 5 || logged.some((s) => s.severity >= 2)) return 'marked';
  if (logged.length > 1) return 'mild';
  return 'calm';
}

export function severityLevelLabel(level) {
  return LEVEL_LABELS[level];
}

// els: {chipsEl, pickerEl, input, addBtn}
// todaySymptoms: [{symptom, severity, is_custom}]
// onLog(symptom, severity, isCustom) → Promise（severity 0 = 清除）
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
    chip.addEventListener('click', async () => {
      if (!rec) {
        pickerEl.innerHTML = '';
        await onLog(name, DEFAULT_SEVERITY, !fixedSymptoms.includes(name));
        return;
      }
      // 已选中：开/收程度面板
      if (pickerEl.dataset.symptom === name) {
        closePicker(pickerEl);
      } else {
        openPicker(pickerEl, name, rec.severity, !fixedSymptoms.includes(name), onLog);
      }
    });
    chipsEl.appendChild(chip);
  }

  addBtn.onclick = async () => {
    const name = input.value.trim();
    if (!name) return;
    input.value = '';
    pickerEl.innerHTML = '';
    await onLog(name, DEFAULT_SEVERITY, !fixedSymptoms.includes(name));
  };
}

function closePicker(pickerEl) {
  pickerEl.innerHTML = '';
  delete pickerEl.dataset.symptom;
}

function openPicker(pickerEl, symptom, currentSeverity, isCustom, onLog) {
  pickerEl.innerHTML = '';
  pickerEl.dataset.symptom = symptom;
  const box = document.createElement('div');
  box.className = 'severity-picker';
  const label = document.createElement('div');
  label.className = 'label';
  label.textContent = `「${symptom}」程度？`;
  const options = document.createElement('div');
  options.className = 'options';
  for (const severity of [1, 2, 3]) {
    const btn = document.createElement('button');
    btn.className = `sev-${severity}${severity === currentSeverity ? ' cur' : ''}`;
    btn.textContent = SEVERITY_LABELS[severity];
    btn.addEventListener('click', async () => {
      closePicker(pickerEl);
      await onLog(symptom, severity, isCustom);
    });
    options.appendChild(btn);
  }
  const clear = document.createElement('button');
  clear.textContent = '清除';
  clear.className = 'danger';
  clear.addEventListener('click', async () => {
    closePicker(pickerEl);
    await onLog(symptom, 0, isCustom);
  });
  options.appendChild(clear);
  box.append(label, options);
  pickerEl.appendChild(box);
}
