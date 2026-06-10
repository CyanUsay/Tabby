// Supabase PostgREST 直连封装。不用 SDK：只需 select/insert/upsert，fetch 足够。
// 注意：RLS 只开了 select/insert/update，没有 delete —— 纠错走 Supabase dashboard。
// 新版 sb_publishable_ key 不是 JWT，只放 apikey 头（不放 Authorization，以 anon 角色访问）。

import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';

async function rest(path, { method = 'GET', body, headers = {} } = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: SUPABASE_ANON_KEY,
      'Content-Type': 'application/json',
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`PostgREST ${res.status} on ${path}: ${text}`);
  }
  if (res.status === 204) return null;
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

const UPSERT_HEADERS = { Prefer: 'resolution=merge-duplicates,return=representation' };

export function fetchTodayIntake(date) {
  return rest(`intake_log?date=eq.${date}&select=*`);
}

// rows: [{date, supplement, slot, dose, taken, mode}]
export function upsertIntake(rows) {
  if (!rows.length) return Promise.resolve([]);
  return rest('intake_log?on_conflict=date,supplement,slot', {
    method: 'POST',
    headers: UPSERT_HEADERS,
    body: rows.map((r) => ({ ...r, updated_at: new Date().toISOString() })),
  });
}

// rows: [{date, symptom, severity, is_custom, note}]
export function upsertSymptoms(rows) {
  if (!rows.length) return Promise.resolve([]);
  return rest('symptom_log?on_conflict=date,symptom', {
    method: 'POST',
    headers: UPSERT_HEADERS,
    body: rows,
  });
}

export function fetchTodaySymptoms(date) {
  return rest(`symptom_log?date=eq.${date}&select=*`);
}

export function insertCycleEvent({ event, date }) {
  // 同一天重复同一事件直接忽略（unique(event,date)）
  return rest('cycle_event?on_conflict=event,date', {
    method: 'POST',
    headers: { Prefer: 'resolution=ignore-duplicates' },
    body: [{ event, date }],
  });
}

export function fetchCycleEvents() {
  return rest('cycle_event?select=event,date&order=date.desc&limit=200');
}

export function fetchFixedSymptoms() {
  return rest('symptom_catalog?is_fixed=eq.true&select=name&order=name');
}

// 临时症状入字典 / 计数 +1（单用户场景，read-then-write 的竞态可忽略）
export async function bumpSymptomCatalog(name) {
  const rows = await rest(`symptom_catalog?name=eq.${encodeURIComponent(name)}&select=name,count`);
  if (rows.length > 0) {
    await rest(`symptom_catalog?name=eq.${encodeURIComponent(name)}`, {
      method: 'PATCH',
      body: { count: rows[0].count + 1 },
    });
  } else {
    await rest('symptom_catalog', {
      method: 'POST',
      body: [{ name, is_fixed: false, count: 1 }],
    });
  }
}
