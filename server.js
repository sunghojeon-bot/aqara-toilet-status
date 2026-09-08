#!/usr/bin/env node
/**
 * Aqara 화장실 재실 현황판 (Toilet Occupancy Board)
 * - Aqara MCP (https://agent.aqara.com/open/mcp) 로 재실센서/열림감지센서 상태 조회
 * - .env 또는 config.json 의 API 키로 상시 연동 (재로그인 불필요)
 * - 이름에 "화장실"이 들어간 센서를 층별로 자동 매핑
 * - 의존성 없음: Node.js 18+ 만 있으면 실행  →  node server.js
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// .env 로더 (키 이름 대소문자 무관)
// ---------------------------------------------------------------------------
function loadEnv() {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let val = m[2].trim().replace(/^["'<]+|[>"']+$/g, '').trim();
    const hash = val.indexOf(' #');
    if (hash !== -1) val = val.slice(0, hash).trim();
    const key = m[1].toUpperCase();
    if (val && !process.env[key]) process.env[key] = val;
  }
}
loadEnv();

const CONFIG_PATH = path.join(__dirname, 'config.json');

const DEFAULT_CONFIG = {
  homeName: 'AL Office',          // MCP에서 switch_home 할 홈 이름
  apiKey: '',                     // .env 가 없을 때 사용
  mcpUrl: 'https://agent.aqara.com/open/mcp',
  pollIntervalMs: 3000,
  occupiedThresholdSec: 10,       // 마지막 감지 후 N초 이내면 "사용 중"
  doorGraceSec: 120,              // 문 닫힘 직후 재실 확인 유예시간(초)
  tzOffsetHours: 9,               // Aqara 응답 시각의 타임존 (KST)
  autoMap: true,                  // 이름에 "화장실" 포함 센서 자동 매핑
  floors: [
    { id: 'B1', label: '지하 1층', gender: 'female', presenceDeviceId: '', doorDeviceId: '' },
    { id: '1F', label: '1층',      gender: 'unisex', presenceDeviceId: '', doorDeviceId: '' },
    { id: '2F', label: '2층',      gender: 'male',   presenceDeviceId: '', doorDeviceId: '' },
    { id: '3F', label: '3층',      gender: 'female', presenceDeviceId: '', doorDeviceId: '' },
    { id: '4F', label: '4층',      gender: 'male',   presenceDeviceId: '', doorDeviceId: '' },
    { id: '5F', label: '5층',      gender: 'unisex', presenceDeviceId: '', doorDeviceId: '' },
  ],
};

function loadConfig() {
  try {
    const j = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    const cfg = { ...JSON.parse(JSON.stringify(DEFAULT_CONFIG)), ...j };
    if (!Array.isArray(cfg.floors) || !cfg.floors.length) cfg.floors = DEFAULT_CONFIG.floors;
    // 성별/라벨은 항상 코드 기준으로 강제 (저장된 옛 설정이 덮어쓰지 못하게)
    for (const f of cfg.floors) {
      const base = DEFAULT_CONFIG.floors.find((d) => d.id === f.id);
      if (base) { f.gender = base.gender; f.label = base.label; }
    }
    return cfg;
  } catch {
    return JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  }
}
function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), 'utf8');
}
let config = loadConfig();

const PORT = Number(process.env.PORT || 3000);
const MCP_URL = process.env.AQARA_MCP_URL || config.mcpUrl;
const API_KEY = (process.env.AQARA_API_KEY || config.apiKey || '').trim();
const DEMO_MODE = !API_KEY;

// ---------------------------------------------------------------------------
// MCP 클라이언트 (Streamable HTTP, JSON-RPC 2.0)
// ---------------------------------------------------------------------------
let rpcId = 0;
let sessionId = null;
let initialized = false;
let homeSwitched = false;

function mcpHeaders() {
  const h = {
    'Content-Type': 'application/json',
    'Accept': 'application/json, text/event-stream',
    'Authorization': `Bearer ${API_KEY}`,
  };
  if (sessionId) h['Mcp-Session-Id'] = sessionId;
  return h;
}

function parseMcpBody(text, contentType, wantId) {
  if (!text) return null;
  if ((contentType || '').includes('text/event-stream')) {
    let last = null;
    for (const line of text.split('\n')) {
      if (!line.startsWith('data:')) continue;
      const chunk = line.slice(5).trim();
      if (!chunk) continue;
      try {
        const j = JSON.parse(chunk);
        if (wantId === undefined || j.id === wantId) last = j;
      } catch { /* skip */ }
    }
    return last;
  }
  try { return JSON.parse(text); } catch { return null; }
}

async function mcpPost(payload) {
  const res = await fetch(MCP_URL, {
    method: 'POST', headers: mcpHeaders(), body: JSON.stringify(payload),
  });
  const sid = res.headers.get('mcp-session-id');
  if (sid) sessionId = sid;
  const text = await res.text();
  if (!res.ok) {
    const err = new Error(`MCP HTTP ${res.status}: ${text.slice(0, 300)}`);
    err.httpStatus = res.status;
    throw err;
  }
  const msg = parseMcpBody(text, res.headers.get('content-type'), payload.id);
  if (msg && msg.error) throw new Error(`MCP error ${msg.error.code}: ${msg.error.message}`);
  return msg ? msg.result : null;
}

async function mcpInitialize() {
  sessionId = null; initialized = false; homeSwitched = false;
  await mcpPost({
    jsonrpc: '2.0', id: ++rpcId, method: 'initialize',
    params: {
      protocolVersion: '2025-03-26', capabilities: {},
      clientInfo: { name: 'aqara-toilet-status', version: '2.0.0' },
    },
  });
  try {
    await fetch(MCP_URL, {
      method: 'POST', headers: mcpHeaders(),
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    });
  } catch { /* 무시 */ }
  initialized = true;
}

function extractToolText(result) {
  if (!result) return null;
  if (Array.isArray(result.content)) {
    const joined = result.content
      .filter((c) => c && c.type === 'text' && typeof c.text === 'string')
      .map((c) => c.text).join('\n');
    try { return JSON.parse(joined); } catch { return joined; }
  }
  return result;
}

async function mcpCallTool(name, args, retry = true) {
  try {
    if (!initialized) await mcpInitialize();
    if (!homeSwitched && config.homeName && name !== 'switch_home' && name !== 'all_homes_inquiry') {
      try {
        await mcpPost({
          jsonrpc: '2.0', id: ++rpcId, method: 'tools/call',
          params: { name: 'switch_home', arguments: { home: config.homeName } },
        });
      } catch { /* 홈 전환 실패해도 계속 */ }
      homeSwitched = true;
    }
    const result = await mcpPost({
      jsonrpc: '2.0', id: ++rpcId, method: 'tools/call',
      params: { name, arguments: args || {} },
    });
    return extractToolText(result);
  } catch (e) {
    if (retry) {
      initialized = false; sessionId = null; homeSwitched = false;
      return mcpCallTool(name, args, false);
    }
    throw e;
  }
}

async function mcpListTools() {
  if (!initialized) await mcpInitialize();
  const result = await mcpPost({ jsonrpc: '2.0', id: ++rpcId, method: 'tools/list', params: {} });
  return (result && result.tools) || [];
}

// ---------------------------------------------------------------------------
// Aqara 응답 파싱 (outputs 가 [header, ...rows] 테이블 형태)
// ---------------------------------------------------------------------------
function tableToObjects(outputs) {
  if (!Array.isArray(outputs) || outputs.length < 1 || !Array.isArray(outputs[0])) return [];
  const [header, ...rows] = outputs;
  return rows.map((r) => {
    const o = {};
    header.forEach((h, i) => { o[String(h)] = r[i]; });
    return o;
  });
}

/** "{'motion_detected': '2026-07-14 15:49:29', 'online_offline': 'online'}" → 객체 */
function parseStatusString(s) {
  const out = {};
  if (typeof s !== 'string') return out;
  const re = /'([\w]+)'\s*:\s*'([^']*)'/g;
  let m;
  while ((m = re.exec(s))) out[m[1]] = m[2];
  return out;
}

/** Aqara 시각 문자열(KST) → epoch ms */
function parseAqaraTime(s) {
  const m = String(s || '').match(/(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!m) return null;
  const tz = Number(config.tzOffsetHours ?? 9);
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4] - tz, +m[5], +(m[6] || 0));
}

// ---------------------------------------------------------------------------
// 기기 목록 조회 + "화장실" 자동 매핑
// ---------------------------------------------------------------------------
const SENSOR_TYPES = ['OccupancySensor', 'MotionSensor', 'PresenceSensor', 'DoorSensor', 'ContactSensor'];
let deviceCache = { at: 0, devices: [] };

async function fetchSensorDevices(force = false) {
  if (!force && Date.now() - deviceCache.at < 5 * 60 * 1000 && deviceCache.devices.length) {
    return deviceCache.devices;
  }
  const found = [];
  const seen = new Set();
  for (const t of SENSOR_TYPES) {
    try {
      const data = await mcpCallTool('device_base_inquiry', { device_types: [t] });
      const rows = tableToObjects(data && data.outputs);
      for (const r of rows) {
        const id = r['endpoint id'];
        if (!id || seen.has(id)) continue;
        seen.add(id);
        found.push({
          id: String(id),
          endpointName: String(r['endpoint name'] || ''),
          name: String(r['device name'] || ''),
          type: String(r['device type'] || t),
          position: String(r['position name'] || ''),
        });
      }
    } catch { /* 해당 타입 없음 등 - 무시 */ }
  }
  if (found.length) deviceCache = { at: Date.now(), devices: found };
  return deviceCache.devices;
}

const FLOOR_PATTERNS = {
  B1: /지하\s*1|B1|b1/,
  '1F': /(?<!지하\s*)1\s*층/,
  '2F': /2\s*층/,
  '3F': /3\s*층/,
  '4F': /4\s*층/,
  '5F': /5\s*층/,
};
const PRESENCE_TYPES = /Occupancy|Motion|Presence/i;
const DOOR_TYPES = /Door|Contact/i;

function autoMapFloors(devices) {
  let changed = false;
  const toilet = devices.filter((d) => /화장실|toilet|restroom/i.test(d.name + ' ' + d.endpointName + ' ' + d.position));
  for (const floor of config.floors) {
    const pat = FLOOR_PATTERNS[floor.id];
    if (!pat) continue;
    const candidates = toilet.filter((d) => pat.test(d.name) || pat.test(d.endpointName) || (floor.id !== '1F' && pat.test(d.position)));
    const presence = candidates.find((d) => PRESENCE_TYPES.test(d.type));
    const door = candidates.find((d) => DOOR_TYPES.test(d.type));
    if (presence && floor.presenceDeviceId !== presence.id) { floor.presenceDeviceId = presence.id; changed = true; }
    if (door && floor.doorDeviceId !== door.id) { floor.doorDeviceId = door.id; changed = true; }
  }
  if (changed) saveConfig(config);
  return changed;
}

// ---------------------------------------------------------------------------
// 앱 동기화: "유인/무인" 자동화 실행 이력 (앱과 동일한 전환 시각)
//   Aqara 앱에서 층별로 자동화 2개를 만들어두면 자동 활성화됩니다.
//   예) 이름 "2층 유인" (재실센서: 사람 있음일 때), "2층 무인" (사람 없음일 때)
//   이름에 층 + 유인/무인 이 들어가면 됩니다. 없으면 기존 감지시각 방식으로 동작.
// ---------------------------------------------------------------------------
let autoSync = { at: 0, floors: {} };

function kstString(ms) {
  const tz = Number(config.tzOffsetHours ?? 9);
  const d = new Date(ms + tz * 3600000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}

async function fetchAutoSync() {
  try {
    const now = Date.now();
    const data = await mcpCallTool('automation_execution_history_inquiry', {
      time_range: [kstString(now - 6 * 3600000), kstString(now + 60000)],
    });
    const list = data && data.outputs && Array.isArray(data.outputs.data) ? data.outputs.data : [];
    const floors = {};
    for (const item of list) {
      const name = String(item.automation_name || '');
      const kind = /유인|재실\s*있|occupied/i.test(name) ? 'occupied'
        : /무인|재실\s*없|vacant/i.test(name) ? 'vacant' : null;
      if (!kind) continue;
      const logs = item.execute_logs || {};
      const times = [
        ...(((logs.success || {}).execute_time) || []),
        ...(((logs.failed || {}).execute_time) || []), // 동작 실패해도 트리거는 발생한 것
      ].map(parseAqaraTime).filter(Boolean);
      if (!times.length) continue;
      for (const [fid, pat] of Object.entries(FLOOR_PATTERNS)) {
        if (!pat.test(name)) continue;
        const f = floors[fid] || (floors[fid] = { occupiedTimes: [], vacantTimes: [] });
        (kind === 'occupied' ? f.occupiedTimes : f.vacantTimes).push(...times);
        break; // 첫 매칭 층만 사용
      }
    }
    autoSync = { at: now, floors };
  } catch { /* 실패 시 이전 값 유지 (2분 이상 오래되면 판정에서 무시) */ }
}

// ---------------------------------------------------------------------------
// 출퇴근 기록 (도어락 지문 → "출근 <이름>" / "퇴근 <이름>" 자동화 실행 이력)
//   - 이름 정규화: 공백/특수문자 무시 → 두 도어락의 자동화 이름이 조금 달라도 같은 사람으로 연결
//   - 중복/연속 인증: 같은 날 출근은 최초, 퇴근은 최종 시각만 사용 (재수집해도 멱등)
//   - 자정 이후 퇴근: 05:00 이전 퇴근은 전날 근무의 퇴근으로 귀속 (익일 표시)
//   - 미매칭 인식: 도어락 잠금해제 로그 중 어떤 출근/퇴근 자동화와도 안 맞는 건 "확인 필요"
//   - 보존: Aqara 이력이 ~7일이라 서버가 20초마다 수집해 attendance.json 에 축적
//          (GH_TOKEN + GH_DATA_REPO 설정 시 GitHub 저장소에도 백업/복원)
// ---------------------------------------------------------------------------
const ATT_PATH = path.join(__dirname, 'attendance.json');
const ATT_DAY_CUTOFF_HOUR = 5;   // 이 시각 이전의 퇴근은 전날 근무로 귀속
let attendance = { days: {}, unmatched: {} };
// days: { 'YYYY-MM-DD': { '이름': { in, out, outNextDay, inCount, outCount } } }
// unmatched: { 'YYYY-MM-DD': [ { lock, time } ] }

function attNormalizeName(s) {
  return String(s || '').replace(/[\s_\-·.,:;()\[\]{}]/g, '').trim();
}
function attParseTime(t) {
  const m = String(t).match(/(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/);
  if (!m) return null;
  return { date: `${m[1]}-${m[2]}-${m[3]}`, hhmm: `${m[4]}:${m[5]}`, hour: Number(m[4]),
    ms: Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) };
}
function attPrevDate(dateKey) {
  const d = new Date(dateKey + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}
function attMerge(store, type, person, t) {
  let dateKey = t.date, nextDay = false;
  if (type === 'out' && t.hour < ATT_DAY_CUTOFF_HOUR) { dateKey = attPrevDate(t.date); nextDay = true; }
  const day = store.days[dateKey] || (store.days[dateKey] = {});
  const rec = day[person] || (day[person] = { in: null, out: null, outNextDay: false, inCount: 0, outCount: 0, _seen: {} });
  const seenKey = type + '@' + t.date + ' ' + t.hhmm;
  if (rec._seen[seenKey]) return false;           // 같은 이벤트 재수집 → 무시
  rec._seen[seenKey] = 1;
  if (rec.manual) return false;                   // 시트에서 수동수정된 행은 유지
  if (type === 'in') { rec.inCount++; if (!rec.in || t.hhmm < rec.in) rec.in = t.hhmm; }
  else {
    rec.outCount++;
    const cmp = (nextDay ? '24' : '') + t.hhmm;   // 익일 퇴근은 항상 더 늦은 것으로 취급
    const cur = rec.out ? ((rec.outNextDay ? '24' : '') + rec.out) : null;
    if (!cur || cmp > cur) { rec.out = t.hhmm; rec.outNextDay = nextDay; }
  }
  if (typeof sheetQueue === 'function') sheetQueue(dateKey, person);
  return true;
}
/** 자동화 실행 이력(list) → store 에 반영. 반환: 변경 여부 */
function attApplyHistory(store, list) {
  let changed = false;
  const execTimes = [];                            // 매칭용: 모든 출근/퇴근 실행 시각(ms)
  for (const item of list || []) {
    const name = String(item.automation_name || '').trim();
    const m = name.match(/^(출근|퇴근)[\s_\-:]*(.+)$/);
    if (!m) continue;
    const type = m[1] === '출근' ? 'in' : 'out';
    const person = attNormalizeName(m[2]);
    if (!person) continue;
    const logs = item.execute_logs || {};
    const times = [...(((logs.success || {}).execute_time) || []), ...(((logs.failed || {}).execute_time) || [])];
    for (const raw of times) {
      const t = attParseTime(raw); if (!t) continue;
      execTimes.push(t.ms);
      if (attMerge(store, type, person, t)) changed = true;
    }
  }
  store._execTimes = execTimes;
  return changed;
}
/** 도어락 로그(list) 의 잠금해제 시각 중 자동화 실행과 ±1분 내 매칭 안 되는 것 → unmatched */
function attApplyLockLogs(store, list, execTimes) {
  let changed = false;
  const seen = new Set();
  for (const item of list || []) {
    const lock = String(item.device_name || '도어락');
    const logs = item.execute_logs || {};
    for (const [key, v] of Object.entries(logs)) {
      if (!/lock_state\s+Unlocked/i.test(key)) continue;
      for (const raw of ((v && v.execute_time) || [])) {
        const t = attParseTime(raw); if (!t) continue;
        const k = lock + '@' + t.date + ' ' + t.hhmm;
        if (seen.has(k)) continue; seen.add(k);
        const matched = execTimes.some((ms) => Math.abs(ms - t.ms) <= 60000);
        if (matched) continue;
        const arr = store.unmatched[t.date] || (store.unmatched[t.date] = []);
        if (!arr.some((u) => u.lock === lock && u.time === t.hhmm)) { arr.push({ lock, time: t.hhmm }); changed = true; if (typeof sheetQueueUnmatched === 'function') sheetQueueUnmatched(t.date, { lock, time: t.hhmm }); }
      }
    }
  }
  return changed;
}

// ---- Google 스프레드시트 양방향 연동 (Apps Script 웹앱) ----
//   환경변수: SHEET_WEBHOOK_URL (Apps Script 배포 URL), SHEET_SECRET (공유 비밀키)
//   서버→시트: 기록 변경 시 upsert (날짜+이름 기준), 확인필요 append
//   시트→서버: 부팅 시 전체 복원 + 5분마다 재로드. 시트에서 '수동수정'=Y 인 행은 시트 값이 우선(서버가 덮어쓰지 않음)
const SHEET_URL = (process.env.SHEET_WEBHOOK_URL || '').trim();
const SHEET_SECRET = (process.env.SHEET_SECRET || '').trim();
let sheetPending = { rows: new Map(), unmatched: [] };
let sheetTimer = null;
let sheetLastOk = null, sheetLastErr = null;
const manualRows = new Set();   // 'date|name' — 시트에서 수동수정된 행
async function sheetCall(payload) {
  const r = await fetch(SHEET_URL, {
    method: 'POST', redirect: 'follow',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },   // Apps Script는 text/plain 이 CORS/preflight 없이 안전
    body: JSON.stringify({ secret: SHEET_SECRET, ...payload }),
  });
  const text = await r.text();
  let j; try { j = JSON.parse(text); } catch { throw new Error('sheet bad response: ' + text.slice(0, 120)); }
  if (!j.ok) throw new Error('sheet error: ' + (j.error || 'unknown'));
  return j;
}
function sheetQueue(dateKey, person) {
  if (!SHEET_URL) return;
  if (manualRows.has(dateKey + '|' + person)) return;
  const r = (attendance.days[dateKey] || {})[person]; if (!r) return;
  const status = r.in && r.out ? 'ok' : (r.in ? 'in_only' : 'out_only');
  sheetPending.rows.set(dateKey + '|' + person, { date: dateKey, name: person, in: r.in || '', out: r.out || '', outNextDay: r.outNextDay ? 'Y' : '', inCount: r.inCount || 0, outCount: r.outCount || 0, status });
  sheetFlushLater();
}
function sheetQueueUnmatched(dateKey, u) { if (!SHEET_URL) return; sheetPending.unmatched.push({ date: dateKey, lock: u.lock, time: u.time }); sheetFlushLater(); }
function sheetFlushLater() { clearTimeout(sheetTimer); sheetTimer = setTimeout(sheetFlush, 4000); }
async function sheetFlush() {
  if (!SHEET_URL) return;
  const rows = [...sheetPending.rows.values()], unmatched = sheetPending.unmatched;
  if (!rows.length && !unmatched.length) return;
  sheetPending = { rows: new Map(), unmatched: [] };
  try { await sheetCall({ action: 'upsert', rows, unmatched }); sheetLastOk = new Date().toISOString(); sheetLastErr = null; }
  catch (e) { sheetLastErr = e.message; writeLogLine('sheet upsert failed: ' + e.message);
    for (const r of rows) sheetPending.rows.set(r.date + '|' + r.name, r); sheetPending.unmatched.push(...unmatched); sheetFlushLater(); }
}
/** 시트 → 서버 복원/동기화 */
async function sheetLoad() {
  if (!SHEET_URL) return false;
  try {
    const j = await sheetCall({ action: 'load' });
    for (const row of (j.rows || [])) {
      const date = String(row.date || '').slice(0, 10), name = attNormalizeName(row.name);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !name) continue;
      const day = attendance.days[date] || (attendance.days[date] = {});
      const cur = day[name] || (day[name] = { in: null, out: null, outNextDay: false, inCount: 0, outCount: 0, _seen: {} });
      const manual = String(row.manual || '').trim().toUpperCase() === 'Y';
      const sIn = String(row.in || '').trim() || null, sOut = String(row.out || '').trim() || null;
      const sNext = String(row.outNextDay || '').trim().toUpperCase() === 'Y';
      if (manual) { manualRows.add(date + '|' + name); cur.in = sIn; cur.out = sOut; cur.outNextDay = sNext; cur.manual = true; continue; }
      manualRows.delete(date + '|' + name); cur.manual = false;
      if (sIn && (!cur.in || sIn < cur.in)) cur.in = sIn;
      const a = (sNext ? '24' : '') + (sOut || ''), b = (cur.outNextDay ? '24' : '') + (cur.out || '');
      if (sOut && (!cur.out || a > b)) { cur.out = sOut; cur.outNextDay = sNext; }
      cur.inCount = Math.max(cur.inCount || 0, Number(row.inCount) || 0); cur.outCount = Math.max(cur.outCount || 0, Number(row.outCount) || 0);
    }
    for (const u of (j.unmatched || [])) {
      const date = String(u.date || '').slice(0, 10); if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
      const arr = attendance.unmatched[date] || (attendance.unmatched[date] = []);
      if (!arr.some((x) => x.lock === u.lock && x.time === u.time)) arr.push({ lock: String(u.lock || ''), time: String(u.time || '') });
    }
    // 외근·출장·휴가 (시트 '외근출장' 탭): 날짜별 기록에 leave 로 표시, 도어락 기록이 없어도 그날 행 생성
    const sheetKeys = new Set((j.rows || []).map((r) => String(r.date || '').slice(0, 10) + '|' + attNormalizeName(r.name)));
    const leaveKeys = new Set();
    for (const l of (j.leaves || [])) {
      const date = String(l.date || '').slice(0, 10), name = attNormalizeName(l.name);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !name || !l.type) continue;
      leaveKeys.add(date + '|' + name);
      const day = attendance.days[date] || (attendance.days[date] = {});
      const rec = day[name] || (day[name] = { in: null, out: null, outNextDay: false, inCount: 0, outCount: 0, _seen: {} });
      rec.leave = { type: String(l.type), start: String(l.start || '') || null, end: String(l.end || '') || null, note: String(l.note || '') };
      if (!sheetKeys.has(date + '|' + name)) sheetQueue(date, name);   // 시트 출퇴근기록에도 행 생성 (근무일수 집계용)
    }
    for (const [d, people] of Object.entries(attendance.days)) for (const [p, r] of Object.entries(people)) {
      if (r.leave && !leaveKeys.has(d + '|' + p)) delete r.leave;   // 시트에서 지워진 항목 반영
    }
    sheetLastOk = new Date().toISOString(); sheetLastErr = null;
    return true;
  } catch (e) { sheetLastErr = e.message; writeLogLine('sheet load failed: ' + e.message); return false; }
}

// ---- 저장/복원 (로컬 파일 + 선택적 GitHub 백업) ----
const GH_TOKEN = (process.env.GH_TOKEN || '').trim();
const GH_DATA_REPO = (process.env.GH_DATA_REPO || '').trim();   // 예: sunghojeon-bot/aqara-attendance-data
const GH_DATA_PATH = 'attendance.json';
let ghSha = null;
function attLoadLocal() {
  try {
    const j = JSON.parse(fs.readFileSync(ATT_PATH, 'utf8'));
    if (j && j.days) attendance = j; else if (j && typeof j === 'object') attendance = { days: j, unmatched: {} };
  } catch { /* 없음 */ }
}
async function attLoadGitHub() {
  if (!GH_TOKEN || !GH_DATA_REPO) return false;
  try {
    const r = await fetch(`https://api.github.com/repos/${GH_DATA_REPO}/contents/${GH_DATA_PATH}`, {
      headers: { Authorization: `Bearer ${GH_TOKEN}`, Accept: 'application/vnd.github+json', 'User-Agent': 'aqara-attendance' },
    });
    if (r.status === 404) return false;
    if (!r.ok) throw new Error('GitHub ' + r.status);
    const j = await r.json();
    ghSha = j.sha;
    const remote = JSON.parse(Buffer.from(j.content, 'base64').toString('utf8'));
    // 원격(장기 보관본)과 로컬을 병합: 날짜/사람 단위로 더 이른 출근·더 늦은 퇴근 유지
    for (const [d, people] of Object.entries(remote.days || {})) {
      const day = attendance.days[d] || (attendance.days[d] = {});
      for (const [p, r2] of Object.entries(people)) {
        const cur = day[p];
        if (!cur) { day[p] = r2; continue; }
        if (r2.in && (!cur.in || r2.in < cur.in)) cur.in = r2.in;
        const a = (r2.outNextDay ? '24' : '') + (r2.out || ''), b = (cur.outNextDay ? '24' : '') + (cur.out || '');
        if (r2.out && (!cur.out || a > b)) { cur.out = r2.out; cur.outNextDay = !!r2.outNextDay; }
        cur.inCount = Math.max(cur.inCount || 0, r2.inCount || 0); cur.outCount = Math.max(cur.outCount || 0, r2.outCount || 0);
      }
    }
    for (const [d, arr] of Object.entries(remote.unmatched || {})) {
      const cur = attendance.unmatched[d] || (attendance.unmatched[d] = []);
      for (const u of arr) if (!cur.some((x) => x.lock === u.lock && x.time === u.time)) cur.push(u);
    }
    return true;
  } catch (e) { writeLogLine('attendance github load failed: ' + e.message); return false; }
}
let ghSaveTimer = null;
function attSave() {
  const out = { days: {}, unmatched: attendance.unmatched };
  for (const [d, people] of Object.entries(attendance.days)) {
    out.days[d] = {};
    for (const [p, r] of Object.entries(people)) { const { _seen, ...rest } = r; out.days[d][p] = rest; }
  }
  const text = JSON.stringify(out, null, 2);
  try { fs.writeFileSync(ATT_PATH, text, 'utf8'); } catch { /* ignore */ }
  if (GH_TOKEN && GH_DATA_REPO) {
    clearTimeout(ghSaveTimer);
    ghSaveTimer = setTimeout(async () => {
      try {
        const body = { message: 'attendance update ' + new Date().toISOString(), content: Buffer.from(text, 'utf8').toString('base64') };
        if (ghSha) body.sha = ghSha;
        const r = await fetch(`https://api.github.com/repos/${GH_DATA_REPO}/contents/${GH_DATA_PATH}`, {
          method: 'PUT', headers: { Authorization: `Bearer ${GH_TOKEN}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json', 'User-Agent': 'aqara-attendance' },
          body: JSON.stringify(body),
        });
        const j = await r.json().catch(() => ({}));
        if (r.ok && j.content && j.content.sha) ghSha = j.content.sha;
        else writeLogLine('attendance github save failed: ' + r.status + ' ' + JSON.stringify(j).slice(0, 200));
      } catch (e) { writeLogLine('attendance github save error: ' + e.message); }
    }, 3000);
  }
}
function writeLogLine(msg) { try { fs.appendFileSync(path.join(__dirname, 'server.log'), `[${new Date().toISOString()}] ${msg}\n`); } catch { /* ignore */ } }

// ---- 수집 ----
let lockDevices = { at: 0, list: [] };
async function attFetchLocks() {
  if (Date.now() - lockDevices.at < 10 * 60000 && lockDevices.list.length) return lockDevices.list;
  try {
    const data = await mcpCallTool('device_base_inquiry', { device_types: ['DoorLock'] });
    const rows = tableToObjects(data && data.outputs);
    lockDevices = { at: Date.now(), list: rows.map((r) => String(r['endpoint id'])).filter(Boolean) };
  } catch { /* keep old */ }
  return lockDevices.list;
}
let attBusy = false;
let attLastAt = null;
async function fetchAttendance(hoursBack, withLocks) {
  if (attBusy || DEMO_MODE) return;
  attBusy = true;
  try {
    const now = Date.now();
    const range = [kstString(now - hoursBack * 3600000), kstString(now + 60000)];
    const data = await mcpCallTool('automation_execution_history_inquiry', { time_range: range });
    const list = data && data.outputs && Array.isArray(data.outputs.data) ? data.outputs.data : [];
    let changed = attApplyHistory(attendance, list);
    if (withLocks) {
      const ids = await attFetchLocks();
      if (ids.length) {
        const ld = await mcpCallTool('device_log_inquiry', { device_ids: ids, time_range: range });
        const llist = ld && ld.outputs && Array.isArray(ld.outputs.data) ? ld.outputs.data : [];
        if (attApplyLockLogs(attendance, llist, attendance._execTimes || [])) changed = true;
      }
    }
    attLastAt = new Date().toISOString();
    if (changed) attSave();
  } catch (e) { writeLogLine('attendance fetch failed: ' + e.message); } finally { attBusy = false; }
}
attLoadLocal();
setTimeout(async () => { await attLoadGitHub(); await sheetLoad(); await fetchAttendance(7 * 24, true); }, 8000);   // 부팅: 시트 복원 + 7일 백필
setInterval(() => { sheetLoad(); }, 5 * 60 * 1000);                                             // 5분: 시트 수동수정 반영
setInterval(() => fetchAttendance(3, true), 20 * 1000);                                         // 20초: 최근 3시간
setInterval(() => fetchAttendance(25, true), 5 * 60 * 1000);                                    // 5분: 최근 25시간

/** API 응답용 가공: 상태 판정 + 확인 필요 항목 */
function attBuildReport(days) {
  const tz = Number(config.tzOffsetHours ?? 9);
  const todayKey = new Date(Date.now() + tz * 3600000).toISOString().slice(0, 10);
  const out = [];
  for (let i = 0; i < days; i++) {
    const key = new Date(Date.parse(todayKey + 'T00:00:00Z') - i * 24 * 3600000).toISOString().slice(0, 10);
    const day = attendance.days[key] || {};
    const people = Object.entries(day).map(([name, r]) => {
      let status = 'ok';
      if (r.in && !r.out) status = key === todayKey ? 'working' : 'missing_out';
      else if (!r.in && r.out) status = 'missing_in';
      if (!r.in && !r.out) status = r.leave ? 'leave' : 'absent';
      return { name, in: r.in, out: r.out, outNextDay: !!r.outNextDay, inCount: r.inCount || 0, outCount: r.outCount || 0, status, manual: !!r.manual, leave: r.leave || null };
    }).sort((a, b) => String(a.in || '99').localeCompare(String(b.in || '99')));
    out.push({ date: key, people, unmatched: attendance.unmatched[key] || [] });
  }
  return out;
}
module.exports = module.exports || {};
Object.assign(module.exports, { attApplyHistory, attApplyLockLogs, attBuildReport, attNormalizeName, attStore: () => attendance });

// ---------------------------------------------------------------------------
// 층별 판정
// ---------------------------------------------------------------------------
function minutesAgo(ms) {
  const diff = Math.max(0, Date.now() - ms);
  const min = Math.floor(diff / 60000);
  if (min < 1) return '방금 전';
  if (min < 60) return `${min}분 전`;
  const h = Math.floor(min / 60);
  return h < 24 ? `${h}시간 전` : `${Math.floor(h / 24)}일 전`;
}

// 층별 문 상태 추적 (닫힌 시각 기록용)
const floorState = {};

function judgeFloor(floor, statusRows) {
  const out = {
    id: floor.id, label: floor.label, gender: floor.gender,
    presence: null, doorOpen: null, status: 'unknown', detail: '',
    lastMotion: null, online: null,
    mapped: { presence: !!floor.presenceDeviceId, door: !!floor.doorDeviceId },
  };
  const thresholdMs = Math.max(10, Number(config.occupiedThresholdSec || 10)) * 1000;

  const rowOf = (id) => statusRows.find((r) => r['endpoint id'] === id);

  // ---- 재실센서 ----
  if (floor.presenceDeviceId) {
    const row = rowOf(floor.presenceDeviceId);
    if (row) {
      const st = parseStatusString(row.status);
      out.online = st.online_offline ? st.online_offline === 'online' : null;
      const t = parseAqaraTime(st.motion_detected || st.presence_detected || st.last_motion);
      if (t) {
        out.lastMotion = new Date(t).toISOString();
        out.presence = (Date.now() - t) <= thresholdMs;
      }
      // presence/occupancy 불리언 속성이 있으면 우선 사용
      for (const [k, v] of Object.entries(st)) {
        if (/^(presence|occupancy|exist|someone|human)/i.test(k) && /^(true|false|0|1|yes|no|on|off)$/i.test(v)) {
          out.presence = /^(true|1|yes|on)$/i.test(v);
        }
      }
      if (out.online === false) out.presence = null;
    }
  }

  // ---- 열림감지센서 ----
  if (floor.doorDeviceId) {
    const row = rowOf(floor.doorDeviceId);
    if (row) {
      const st = parseStatusString(row.status);
      for (const [k, v] of Object.entries(st)) {
        if (k === 'online_offline') continue;
        // Aqara ContactSensor: {'close_state': 'True'|'False'} → True = 닫힘
        if (/close_state|closed/i.test(k) && /^(true|false)$/i.test(v)) {
          out.doorOpen = /^false$/i.test(v);
        } else if (/open_state/i.test(k) && /^(true|false)$/i.test(v)) {
          out.doorOpen = /^true$/i.test(v);
        } else if (/open|close|contact|magnet|door|window/i.test(k) || /^(open|opened|close|closed)$/i.test(v)) {
          if (/open/i.test(v)) out.doorOpen = true;
          else if (/close/i.test(v)) out.doorOpen = false;
        }
      }
    }
  }

  // ---- 문 상태 전환 추적 ----
  const stt = floorState[floor.id] || (floorState[floor.id] = { doorClosedAt: null, prevDoorOpen: null });
  if (out.doorOpen === false && stt.prevDoorOpen !== false) stt.doorClosedAt = Date.now();
  if (out.doorOpen === true) stt.doorClosedAt = null;
  stt.prevDoorOpen = out.doorOpen;

  // ---- 앱 동기화 (유인/무인 자동화 실행 이력이 있으면 그 값을 그대로 사용) ----
  let appSynced = false; let appAt = null; let stabilizing = false;
  const as = (Date.now() - autoSync.at < 2 * 60000) ? autoSync.floors[floor.id] : null;
  if (as) {
    const lo = (as.occupiedTimes && as.occupiedTimes.length) ? Math.max(...as.occupiedTimes) : null;
    const lv = (as.vacantTimes && as.vacantTimes.length) ? Math.max(...as.vacantTimes) : null;
    // 깜빡임(무인→유인 재전환이 90초 이내) 이 최근 15분 내 있었던 층인지
    const nowMs = Date.now();
    let flappy = false;
    for (const to of (as.occupiedTimes || [])) {
      if (nowMs - to > 15 * 60000) continue;
      for (const tv of (as.vacantTimes || [])) {
        const d = to - tv;
        if (d >= 0 && d <= 90000) { flappy = true; break; }
      }
      if (flappy) break;
    }
    if (lo !== null && (lv === null || lo > lv)) {
      out.presence = true; appSynced = true; appAt = lo;
    } else if (lv !== null && (lo === null || lv > lo)) {
      // 깜빡이는 층은 무인 기록을 처음 확인한 시점부터 20초 유지된 뒤에만 '사용 가능' 확정
      const st2 = floorState[floor.id] || (floorState[floor.id] = {});
      if (st2.lastVacantTs !== lv) { st2.lastVacantTs = lv; st2.vacantSeenAt = nowMs; }
      if (flappy && nowMs - st2.vacantSeenAt < 20000) {
        out.presence = true; appSynced = true; appAt = lo || lv; stabilizing = true;
      } else {
        out.presence = false; appSynced = true; appAt = lv;
      }
    } else if (lo !== null && lv !== null && lo === lv && flappy) {
      // 같은 분에 유인/무인 동시 기록 + 깜빡임 → 사람 있는 것으로 유지
      out.presence = true; appSynced = true; appAt = lo; stabilizing = true;
    }
  }
  // 하이브리드: 앱 동기화가 '무인'이어도, 무인 전환 이후의 새 움직임이 감지되면
  // 즉시 '사용 중' (자동화 이력은 분 단위라 입장 직후 최대 1분 늦게 반영되는 것 보완)
  if (appSynced && out.presence === false && out.lastMotion) {
    const lm = Date.parse(out.lastMotion);
    // 여유 120초: 자동화 시각이 분 단위 절삭이라, 퇴장 직후의 마지막 움직임을
    // 재입장으로 오인하지 않도록 무인 전환 후 2분 이상 지난 새 움직임만 인정
    if (lm >= appAt + 120000 && (Date.now() - lm) <= thresholdMs) {
      out.presence = true; appSynced = false; // 감지 기반 즉시 반영
    }
  }
  out.appSync = appSynced;

  // ---- 1인용 화장실 판정 (재실센서 단독 기준) ----
  //   앱 동기화 가능 시: 앱의 유인/무인 전환과 동일
  //   아니면: 마지막 감지 후 threshold 이내 → 사용 중
  //   문 열림/닫힘은 참고 표시만 하고 판정에는 사용하지 않음
  const ago = out.lastMotion ? ` · 마지막 감지 ${minutesAgo(Date.parse(out.lastMotion))}` : '';

  if (!floor.presenceDeviceId) {
    out.status = 'unknown'; out.detail = '재실센서 설치 대기';
  } else if (out.online === false) {
    out.status = 'unknown'; out.detail = '센서 오프라인';
  } else if (out.presence === true) {
    out.status = 'occupied';
    out.detail = appSynced
      ? (stabilizing ? '유인 · 앱 동기화 (안정화 중)' : `유인 · 앱 동기화 (${minutesAgo(appAt)} 전환)`)
      : '재실 감지' + ago;
  } else if (out.presence === false) {
    out.status = 'available';
    out.detail = appSynced ? `무인 · 앱 동기화 (${minutesAgo(appAt)} 전환)` : '재실 없음' + ago;
  } else {
    out.status = 'unknown'; out.detail = '상태 조회 대기';
  }
  return out;
}

// ---------------------------------------------------------------------------
// 폴링
// ---------------------------------------------------------------------------
let cache = { updatedAt: null, floors: [], error: null, demo: DEMO_MODE, home: null };
let lastRaw = null;

async function pollOnce() {
  config = loadConfig();
  if (DEMO_MODE) {
    cache = { updatedAt: new Date().toISOString(), demo: true, error: null, home: '(데모)', floors: demoFloors() };
    return;
  }
  try {
    // 자동 매핑 (미매핑 층이 있을 때만 기기 목록 조회)
    if (config.autoMap && config.floors.some((f) => !f.presenceDeviceId)) {
      const devices = await fetchSensorDevices();
      autoMapFloors(devices);
    }
    const ids = [];
    for (const f of config.floors) {
      if (f.presenceDeviceId) ids.push(f.presenceDeviceId);
      if (f.doorDeviceId) ids.push(f.doorDeviceId);
    }
    let statusRows = [];
    if (ids.length) {
      const data = await mcpCallTool('device_status_inquiry', { device_ids: ids });
      lastRaw = data;
      statusRows = tableToObjects(data && data.outputs);
      await fetchAutoSync(); // 앱 동기화용 자동화 실행 이력
    }
    cache = {
      updatedAt: new Date().toISOString(), demo: false, error: null,
      home: config.homeName,
      floors: config.floors.map((f) => judgeFloor(f, statusRows)),
    };
  } catch (e) {
    cache = { ...cache, updatedAt: new Date().toISOString(), error: String(e.message || e) };
  }
  writeLog();
}

// 데모 모드
const demoState = {};
function demoFloors() {
  return config.floors.map((f) => {
    if (!demoState[f.id] || Math.random() < 0.07) {
      const occupied = Math.random() < 0.4;
      demoState[f.id] = { presence: occupied, doorOpen: !occupied && Math.random() < 0.6 };
    }
    const s = demoState[f.id];
    return {
      id: f.id, label: f.label, gender: f.gender,
      presence: s.presence, doorOpen: s.doorOpen,
      status: s.presence ? 'occupied' : 'available',
      detail: s.presence ? '재실 감지 (데모)' : '재실 없음 (데모)',
      lastMotion: null, online: true,
      mapped: { presence: true, door: true },
    };
  });
}

// ---------------------------------------------------------------------------
// 로그 (원격 진단용)
// ---------------------------------------------------------------------------
const startedAt = new Date().toISOString();
function writeLog() {
  try {
    const mapped = config.floors.map((f) => `${f.id}:${f.presenceDeviceId ? 'P' : '-'}${f.doorDeviceId ? 'D' : '-'}`).join(' ');
    fs.writeFileSync(path.join(__dirname, 'server.log'),
      `started: ${startedAt}\nmode: ${DEMO_MODE ? 'demo' : 'aqara-mcp'}\nhome: ${config.homeName}\n` +
      `lastUpdate: ${cache.updatedAt}\nlastError: ${cache.error || '-'}\nmapping: ${mapped}\n` +
      `floors: ${JSON.stringify(cache.floors)}\n`, 'utf8');
  } catch { /* ignore */ }
}

let pollBusy = false;
setInterval(async () => {
  if (pollBusy) return; // 이전 폴링이 끝나기 전 중복 실행 방지
  pollBusy = true;
  try { await pollOnce(); } finally { pollBusy = false; }
}, Math.max(2000, config.pollIntervalMs || 3000));
pollOnce();

// ---------------------------------------------------------------------------
// HTTP 서버
// ---------------------------------------------------------------------------
function send(res, code, body, type = 'application/json') {
  const data = type === 'application/json' ? JSON.stringify(body) : body;
  res.writeHead(code, { 'Content-Type': `${type}; charset=utf-8`, 'Cache-Control': 'no-store' });
  res.end(data);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let b = '';
    req.on('data', (c) => { b += c; if (b.length > 1e6) req.destroy(); });
    req.on('end', () => resolve(b));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  try {
    if (url.pathname === '/' || url.pathname === '/index.html') {
      const html = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
      return send(res, 200, html, 'text/html');
    }
    if (url.pathname === '/door') {
      const html = fs.readFileSync(path.join(__dirname, 'public', 'door.html'), 'utf8');
      return send(res, 200, html, 'text/html');
    }
    // 1층 출입문 개폐 장면 실행 (비밀번호 보호)
    if (url.pathname === '/api/door/open' && req.method === 'POST') {
      const DOOR_PIN = (process.env.DOOR_PIN || '').trim();
      if (!DOOR_PIN) return send(res, 500, { ok: false, error: '서버에 DOOR_PIN 환경변수가 설정되지 않았습니다.' });
      const body = JSON.parse(await readBody(req) || '{}');
      if (String(body.pin || '') !== DOOR_PIN) return send(res, 403, { ok: false, error: '비밀번호가 올바르지 않습니다.' });
      if (DEMO_MODE) return send(res, 200, { ok: true, demo: true });
      const action = String(body.action || 'open');
      const sceneName = action === 'close'
        ? (config.doorCloseSceneName || '1층 출입문 닫기')
        : (config.doorSceneName || '1층 출입문 개폐');
      const list = await mcpCallTool('scene_base_inquiry', {});
      const rows = tableToObjects(list && list.outputs);
      const scene = rows.find((r) => String(r['scene name'] || '').trim() === sceneName);
      if (!scene) return send(res, 404, { ok: false, error: `"${sceneName}" 장면을 찾을 수 없습니다.` });
      const run = await mcpCallTool('scene_run', { scene_ids: [scene['scene id']] });
      writeLog();
      return send(res, 200, { ok: true, result: (run && run.message) || 'executed' });
    }
    if (url.pathname === '/attendance') {
      const html = fs.readFileSync(path.join(__dirname, 'public', 'attendance.html'), 'utf8');
      return send(res, 200, html, 'text/html');
    }
    if (url.pathname === '/api/attendance') {
      const days = Math.min(92, Math.max(1, Number(url.searchParams.get('days') || 31)));
      return send(res, 200, { updatedAt: new Date().toISOString(), collectedAt: attLastAt,
        pollSec: 20, storage: SHEET_URL ? 'sheet+local' : ((GH_TOKEN && GH_DATA_REPO) ? 'github+local' : 'local'),
        sheet: SHEET_URL ? { lastOk: sheetLastOk, lastErr: sheetLastErr } : null, days: attBuildReport(days) });
    }
    if (url.pathname === '/api/status') return send(res, 200, cache);
    if (url.pathname === '/api/config' && req.method === 'GET') {
      const c = loadConfig();
      return send(res, 200, { ...c, apiKey: c.apiKey ? '(설정됨)' : '', demo: DEMO_MODE });
    }
    if (url.pathname === '/api/config' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req) || '{}');
      const cfg = loadConfig();
      if (Array.isArray(body.floors)) {
        for (const f of body.floors) {
          const target = cfg.floors.find((x) => x.id === f.id);
          if (target) {
            if ('presenceDeviceId' in f) target.presenceDeviceId = String(f.presenceDeviceId || '').trim();
            if ('doorDeviceId' in f) target.doorDeviceId = String(f.doorDeviceId || '').trim();
          }
        }
      }
      for (const k of ['pollIntervalMs', 'occupiedThresholdSec', 'homeName', 'autoMap']) {
        if (k in body) cfg[k] = body[k];
      }
      saveConfig(cfg);
      config = cfg;
      pollOnce();
      return send(res, 200, { ok: true });
    }
    if (url.pathname === '/api/devices') {
      if (DEMO_MODE) {
        return send(res, 200, {
          demo: true,
          devices: config.floors.flatMap((f) => ([
            { id: `demo.presence.${f.id}`, name: `FP2 재실센서 ${f.label}`, type: 'OccupancySensor', position: f.label },
            { id: `demo.door.${f.id}`, name: `열림감지센서 ${f.label}`, type: 'DoorSensor', position: f.label },
          ])),
        });
      }
      const devices = await fetchSensorDevices(true);
      return send(res, 200, { demo: false, devices });
    }
    if (url.pathname === '/api/automap') {
      const devices = await fetchSensorDevices(true);
      const changed = autoMapFloors(devices);
      pollOnce();
      return send(res, 200, { ok: true, changed, devices: devices.length });
    }
    if (url.pathname === '/api/tools') {
      if (DEMO_MODE) return send(res, 200, { demo: true, tools: [] });
      const tools = await mcpListTools();
      return send(res, 200, { tools: tools.map((t) => ({ name: t.name })) });
    }
    if (url.pathname === '/api/raw') return send(res, 200, { raw: lastRaw });
    return send(res, 404, { error: 'not found' });
  } catch (e) {
    return send(res, 500, { error: String(e.message || e) });
  }
});

server.listen(PORT, () => {
  writeLog();
  console.log('──────────────────────────────────────────────');
  console.log('  Aqara 화장실 재실 현황판');
  console.log(`  http://localhost:${PORT}`);
  console.log(`  모드: ${DEMO_MODE ? '데모 (API 키 없음)' : `Aqara MCP 연동 (홈: ${config.homeName})`}`);
  console.log('──────────────────────────────────────────────');
});
