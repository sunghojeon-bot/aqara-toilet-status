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
  occupiedThresholdSec: 15,       // 마지막 감지 후 N초 이내면 "사용 중"
  doorGraceSec: 120,              // 문 닫힘 직후 재실 확인 유예시간(초)
  tzOffsetHours: 9,               // Aqara 응답 시각의 타임존 (KST)
  autoMap: true,                  // 이름에 "화장실" 포함 센서 자동 매핑
  floors: [
    { id: 'B1', label: '지하 1층', gender: 'male',   presenceDeviceId: '', doorDeviceId: '' },
    { id: '1F', label: '1층',      gender: 'unisex', presenceDeviceId: '', doorDeviceId: '' },
    { id: '2F', label: '2층',      gender: 'male',   presenceDeviceId: '', doorDeviceId: '' },
    { id: '3F', label: '3층',      gender: 'female', presenceDeviceId: '', doorDeviceId: '' },
    { id: '4F', label: '4층',      gender: 'male',   presenceDeviceId: '', doorDeviceId: '' },
    { id: '5F', label: '5층',      gender: 'female', presenceDeviceId: '', doorDeviceId: '' },
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
  const thresholdMs = Math.max(10, Number(config.occupiedThresholdSec || 15)) * 1000;

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

  // ---- 1인용 화장실 판정 (재실센서 단독 기준) ----
  //   재실 감지 (threshold 내 움직임) → 사용 중
  //   재실 없음                     → 사용 가능
  //   문 열림/닫힘은 참고 표시만 하고 판정에는 사용하지 않음
  const ago = out.lastMotion ? ` · 마지막 감지 ${minutesAgo(Date.parse(out.lastMotion))}` : '';

  if (!floor.presenceDeviceId) {
    out.status = 'unknown'; out.detail = '재실센서 설치 대기';
  } else if (out.online === false) {
    out.status = 'unknown'; out.detail = '센서 오프라인';
  } else if (out.presence === true) {
    out.status = 'occupied'; out.detail = '재실 감지' + ago;
  } else if (out.presence === false) {
    out.status = 'available'; out.detail = '재실 없음' + ago;
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

setInterval(pollOnce, Math.max(2000, config.pollIntervalMs || 3000));
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
