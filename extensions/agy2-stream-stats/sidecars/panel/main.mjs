// Backend for Antigravity API & Token Stats UI Extension
import { execFile, execSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { Response, SidecarApp } from 'sidecar_sdk';

const execFileAsync = promisify(execFile);

// Ignore self-signed certificates for local HTTPS communication with language server
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const HERE = dirname(fileURLToPath(import.meta.url));
const STARTED_AT = Date.now();
const app = new SidecarApp();

// ---------------------------------------------------------------------------
// Static file serving
// ---------------------------------------------------------------------------
const readLocal = (name) => readFileSync(join(HERE, name), 'utf8');

app.page('/', () => new Response(readLocal('index.html'), { contentType: 'text/html', headers: { 'Cache-Control': 'no-cache' } }));
app.page('/app.js', () => new Response(readLocal('app.js'), { contentType: 'application/javascript', headers: { 'Cache-Control': 'no-cache' } }));
app.api('/styles.css', () => new Response(readLocal('styles.css'), { contentType: 'text/css', headers: { 'Cache-Control': 'no-cache' } }), 'GET');

// ---------------------------------------------------------------------------
// Antigravity Language Server RPC Client
// ---------------------------------------------------------------------------
let cachedBaseUrl = null;
let cachedPort = null;
let cachedCsrf = null;
let cachedFromEnv = false;

function extractCsrfFromHtml(text) {
  const m = text.match(/"csrfToken"\s*:\s*"([^"]+)"/);
  return m ? m[1] : '';
}

function extractPortFromUrlOrAddr(addr) {
  const m = String(addr || '').match(/:(\d+)(?:\/|$)/);
  return m ? m[1] : '';
}

async function probeRpcEndpoint(baseUrl, csrf, timeoutMs = 2000) {
  try {
    const res = await fetch(
      `${baseUrl}/exa.language_server_pb.LanguageServerService/GetUserStatus`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-codeium-csrf-token': csrf,
          'x-grpc-web': '1',
          'x-user-agent': 'antigravity',
        },
        body: JSON.stringify({ metadata: {} }),
        signal: AbortSignal.timeout(timeoutMs),
      }
    );
    return res.ok;
  } catch {
    return false;
  }
}

function getLanguageServerProcessInfo() {
  const pids = new Set();
  let csrf = '';
  try {
    const psCmd =
      'powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"Name=\'language_server.exe\'\\" | Select-Object ProcessId, CommandLine | ConvertTo-Json -Compress"';
    const out = execSync(psCmd, { encoding: 'utf8', timeout: 5000 }).trim();
    if (out) {
      const parsed = JSON.parse(out);
      const list = Array.isArray(parsed) ? parsed : [parsed];
      for (const proc of list) {
        if (proc?.ProcessId != null) {
          pids.add(String(proc.ProcessId));
        }
        const cmd = proc?.CommandLine || '';
        const m = cmd.match(/--csrf_token[=\s]+([^\s"]+)/);
        if (m && m[1]) {
          csrf = m[1];
        }
      }
    }
  } catch (err) {
    console.error('[sidecar] Error querying language_server.exe process:', err.message);
  }

  if (pids.size === 0) {
    try {
      const tl = execSync('tasklist /fi "imagename eq language_server.exe" /fo csv', {
        encoding: 'utf8',
        timeout: 3000,
      });
      for (const match of tl.matchAll(/"language_server\.exe","(\d+)"/g)) {
        pids.add(match[1]);
      }
    } catch {}
  }

  return { pids, csrf };
}

async function probeLanguageServerPort(port, timeoutMs = 1500) {
  try {
    const res = await fetch(`https://127.0.0.1:${port}/`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    if (res.ok && text.includes('csrfToken')) {
      return { ok: true, csrf: extractCsrfFromHtml(text) };
    }
  } catch {}
  return { ok: false, csrf: '' };
}

async function getLanguageServerAuth() {
  if (cachedBaseUrl && cachedCsrf) {
    if (cachedFromEnv) {
      return { baseUrl: cachedBaseUrl, port: cachedPort, csrf: cachedCsrf };
    }
    const probe = await probeLanguageServerPort(cachedPort, 1000);
    if (probe.ok) {
      if (probe.csrf) cachedCsrf = probe.csrf;
      return { baseUrl: cachedBaseUrl, port: cachedPort, csrf: cachedCsrf };
    }
    cachedBaseUrl = null;
    cachedPort = null;
    cachedCsrf = null;
    cachedFromEnv = false;
  }

  // Priority 1: 官方 Sidecar 宿主注入的环境变量 (Antigravity 2.34.0+ 不再在 CLI 暴露 --csrf_token)
  const envAddr = (process.env.ANTIGRAVITY_LS_ADDRESS || '').trim();
  const envCsrf = (process.env.ANTIGRAVITY_CSRF_TOKEN || '').trim();
  if (envAddr && envCsrf && !envAddr.endsWith(':0')) {
    const cleanAddr = envAddr.replace(/\/+$/, '');
    const candidates = /^https?:\/\//i.test(cleanAddr)
      ? [cleanAddr]
      : [`http://${cleanAddr}`, `https://${cleanAddr}`];
    for (const baseUrl of candidates) {
      if (await probeRpcEndpoint(baseUrl, envCsrf, 2500)) {
        cachedBaseUrl = baseUrl;
        cachedPort = extractPortFromUrlOrAddr(cleanAddr);
        cachedCsrf = envCsrf;
        cachedFromEnv = true;
        return { baseUrl: cachedBaseUrl, port: cachedPort, csrf: cachedCsrf };
      }
    }
  }

  let procInfo = null;
  const getProcInfo = () => {
    if (!procInfo) procInfo = getLanguageServerProcessInfo();
    return procInfo;
  };

  // Priority 2: Legacy ui_port.txt fallback
  const candidatePaths = [
    join(homedir(), '.gemini', 'antigravity', 'ui_port.txt'),
    'd:\\programme\\antigravity-api-stats\\ui_port.txt',
  ];

  for (const p of candidatePaths) {
    if (existsSync(p)) {
      try {
        const pt = readFileSync(p, 'utf8').trim();
        if (pt) {
          const probe = await probeLanguageServerPort(pt, 1500);
          if (probe.ok) {
            const csrf = probe.csrf || envCsrf || getProcInfo().csrf;
            if (csrf) {
              cachedBaseUrl = `https://127.0.0.1:${pt}`;
              cachedPort = pt;
              cachedCsrf = csrf;
              cachedFromEnv = false;
              return { baseUrl: cachedBaseUrl, port: cachedPort, csrf: cachedCsrf };
            }
          }
        }
      } catch {}
    }
  }

  // Priority 3: Scan language_server.exe listening ports
  try {
    const { pids, csrf: procCsrf } = getProcInfo();
    const ns = execSync('netstat -ano', { encoding: 'utf8', timeout: 3000 });
    const ports = [];
    for (const line of ns.split(/\r?\n/)) {
      const parts = line.trim().split(/\s+/);
      if (
        parts.length >= 5 &&
        parts[1]?.startsWith('127.0.0.1:') &&
        parts[3] === 'LISTENING' &&
        pids.has(parts[4])
      ) {
        ports.push(parts[1].split(':')[1]);
      }
    }

    for (const port of ports) {
      const probe = await probeLanguageServerPort(port, 1500);
      if (probe.ok) {
        const csrf = probe.csrf || envCsrf || procCsrf;
        if (csrf) {
          cachedBaseUrl = `https://127.0.0.1:${port}`;
          cachedPort = port;
          cachedCsrf = csrf;
          cachedFromEnv = false;
          try {
            writeFileSync(join(homedir(), '.gemini', 'antigravity', 'ui_port.txt'), port, 'utf8');
          } catch {}
          return { baseUrl: cachedBaseUrl, port, csrf };
        }
      }
    }
  } catch (err) {
    console.error('[sidecar] Error scanning language_server port:', err.message);
  }

  return null;
}

async function callRpc(method, body = {}, retried = false) {
  const auth = await getLanguageServerAuth();
  if (!auth) {
    throw new Error('无法连接到本地 Antigravity Language Server，请确认客户端正在运行');
  }

  const url = `${auth.baseUrl}/exa.language_server_pb.LanguageServerService/${method}`;
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-codeium-csrf-token': auth.csrf,
        'x-grpc-web': '1',
        'x-user-agent': 'antigravity',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
  } catch (err) {
    if (!retried) {
      cachedBaseUrl = null;
      cachedPort = null;
      cachedCsrf = null;
      cachedFromEnv = false;
      return callRpc(method, body, true);
    }
    throw err;
  }

  if (res.status === 401 && !retried) {
    cachedBaseUrl = null;
    cachedPort = null;
    cachedCsrf = null;
    cachedFromEnv = false;
    return callRpc(method, body, true);
  }

  const text = await res.text();
  const idx = text.indexOf('{');
  if (idx < 0) {
    throw new Error(`RPC ${method} 返回空或非法数据 (HTTP ${res.status})`);
  }
  const json = JSON.parse(text.slice(idx));
  if (!res.ok || json.code === 'unauthenticated') {
    if (json.code === 'unauthenticated' && !retried) {
      cachedPort = null;
      cachedCsrf = null;
      return callRpc(method, body, true);
    }
    throw new Error(json.message || `RPC ${method} 请求失败 (HTTP ${res.status})`);
  }
  return json;
}

// ---------------------------------------------------------------------------
// Helpers & Model Label Resolution
// ---------------------------------------------------------------------------

const WORKSPACE_DIR = 'd:\\programme\\antigravity-api-stats';
let cachedModelMap = {};
let modelMapLoadedAt = 0;

function loadStaticModelMap() {
  const candidates = [
    join(WORKSPACE_DIR, 'model_map.json'),
    join(homedir(), '.gemini', 'antigravity', 'model_map.json'),
  ];
  const map = {};
  for (const p of candidates) {
    if (!existsSync(p)) continue;
    try {
      Object.assign(map, JSON.parse(readFileSync(p, 'utf8')));
    } catch {}
  }
  return map;
}

function updateModelMapFromConfigs(cfgs = []) {
  const merged = { ...loadStaticModelMap(), ...cachedModelMap };
  for (const c of cfgs) {
    const id = c?.modelOrAlias?.model || c?.model;
    if (id && c?.label) {
      merged[id] = c.label;
    }
  }
  cachedModelMap = merged;
  modelMapLoadedAt = Date.now();
  return merged;
}

async function getModelLabelMap() {
  if (Date.now() - modelMapLoadedAt < 60_000 && Object.keys(cachedModelMap).length > 0) {
    return cachedModelMap;
  }
  const base = { ...loadStaticModelMap(), ...cachedModelMap };
  try {
    const raw = await callRpc('GetUserStatus', { metadata: {} });
    const cfgs = raw?.userStatus?.cascadeModelConfigData?.clientModelConfigs || [];
    return updateModelMapFromConfigs(cfgs);
  } catch {
    cachedModelMap = base;
    return base;
  }
}

function resolveModelLabel(enumOrName, fallback, modelMap) {
  if (enumOrName && modelMap[enumOrName]) return modelMap[enumOrName];
  if (fallback && modelMap[fallback]) return modelMap[fallback];
  if (fallback) return fallback;
  if (enumOrName && enumOrName.startsWith('MODEL_PLACEHOLDER_')) {
    return `未知模型 (${enumOrName.split('_').pop()})`;
  }
  return enumOrName || 'Unknown';
}

function parseSeconds(val) {
  if (typeof val === 'number') return Number.isFinite(val) ? val : null;
  if (typeof val !== 'string') return null;
  const n = parseFloat(val);
  return Number.isFinite(n) ? n : null;
}

function parseIsoMs(val) {
  if (!val || typeof val !== 'string') return null;
  const ms = Date.parse(val);
  return Number.isFinite(ms) ? ms : null;
}

function toQuotaPercent(frac) {
  if (typeof frac !== 'number' || !Number.isFinite(frac)) return 100;
  const pct = Math.min(100, Math.max(0, frac * 100));
  if (pct > 0 && pct < 10) return Number(pct.toFixed(1));
  return Math.round(pct);
}

// ---------------------------------------------------------------------------
// APIs
// ---------------------------------------------------------------------------

function getLatestConversationId() {
  const convDir = join(homedir(), '.gemini', 'antigravity', 'conversations');
  if (!existsSync(convDir)) return null;
  try {
    const files = readdirSync(convDir)
      .filter((f) => f.endsWith('.db') || f.endsWith('.db-wal'))
      .map((f) => ({ name: f, time: statSync(join(convDir, f)).mtimeMs }))
      .sort((a, b) => b.time - a.time);
    return files[0] ? files[0].name.replace(/\.db(-wal)?$/, '') : null;
  } catch {
    return null;
  }
}

// GET /api/status
app.api('/api/status', async () => {
  const auth = await getLanguageServerAuth().catch(() => null);
  return {
    ok: true,
    uptimeSeconds: Math.round((Date.now() - STARTED_AT) / 1000),
    languageServer: auth ? { connected: true, port: auth.port } : { connected: false },
    latestConversationId: getLatestConversationId(),
    timestamp: new Date().toISOString(),
  };
}, 'GET');

// GET /api/conversations: 列出近期活跃会话列表以支持切换分析
app.api('/api/conversations', async () => {
  try {
    const raw = await callRpc('GetAllCascadeTrajectories', {});
    const summaries = raw.trajectorySummaries || {};
    const items = Object.entries(summaries)
      .map(([id, info]) => ({
        id,
        title: info?.annotations?.title || info?.summary || id.slice(0, 8),
        stepCount: Number(info?.stepCount) || 0,
        status: info?.status || '',
        createdTime: info?.createdTime || null,
        lastModifiedTime: info?.lastModifiedTime || info?.createdTime || null,
      }))
      .sort((a, b) => (parseIsoMs(b.lastModifiedTime) || 0) - (parseIsoMs(a.lastModifiedTime) || 0))
      .slice(0, 30);
    return { success: true, conversations: items };
  } catch (err) {
    return { success: false, error: err.message, conversations: [] };
  }
}, 'GET');

// ---------------------------------------------------------------------------
// SQLite Persistent Store (agy2-stats.db) & 15-min Quota Sampler
// ---------------------------------------------------------------------------

const STATS_DB_PATH = join(homedir(), '.gemini', 'antigravity', 'agy2-stats.db');
const LEGACY_QUOTA_HISTORY_PATH = join(homedir(), '.gemini', 'antigravity', 'agy2-quota-history.json');
const LEGACY_TRAJ_CACHE_PATH = join(homedir(), '.gemini', 'antigravity', 'agy2-traj-events-cache.json');
const SAMPLE_INTERVAL_MS = 15 * 60 * 1000; // 每 15 分钟采样一次
const HIST_KEPT_MS = 45 * 24 * 3600 * 1000;
const HIST_MAX_POINTS = 6000;
const HIST_SLACK_MS = 5 * 60 * 1000;
const HIST_MAX_INTERVALS = 240;

let statsDb = null;

function getStatsDb() {
  if (statsDb) return statsDb;
  const db = new DatabaseSync(STATS_DB_PATH);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    CREATE TABLE IF NOT EXISTS kv_store (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS conv_cache (
      conv_id TEXT PRIMARY KEY,
      sig TEXT NOT NULL,
      max_ts INTEGER NOT NULL DEFAULT 0,
      archived INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS usage_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conv_id TEXT NOT NULL,
      ts INTEGER NOT NULL,
      model_id TEXT,
      response_model TEXT,
      in_tok INTEGER NOT NULL DEFAULT 0,
      cache_tok INTEGER NOT NULL DEFAULT 0,
      out_tok INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_usage_events_ts ON usage_events(ts);
    CREATE INDEX IF NOT EXISTS idx_usage_events_conv ON usage_events(conv_id);
  `);
  statsDb = db;
  migrateLegacyJsonToDb(db);
  return db;
}

function migrateLegacyJsonToDb(db) {
  const now = Date.now();
  // 1. 迁移旧版配额采样历史 (agy2-quota-history.json -> kv_store)
  const hasHist = db.prepare('SELECT 1 FROM kv_store WHERE key = ?').get('quota_history');
  if (!hasHist && existsSync(LEGACY_QUOTA_HISTORY_PATH)) {
    try {
      const raw = readFileSync(LEGACY_QUOTA_HISTORY_PATH, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && parsed.accounts) {
        db.prepare(
          'INSERT OR REPLACE INTO kv_store(key, value, updated_at) VALUES (?, ?, ?)'
        ).run('quota_history', JSON.stringify(parsed), now);
      }
    } catch {}
  }

  // 2. 迁移旧版轨迹事件缓存 (agy2-traj-events-cache.json -> conv_cache + usage_events)
  const convCount = db.prepare('SELECT COUNT(*) AS c FROM conv_cache').get()?.c || 0;
  if (convCount === 0 && existsSync(LEGACY_TRAJ_CACHE_PATH)) {
    try {
      const parsed = JSON.parse(readFileSync(LEGACY_TRAJ_CACHE_PATH, 'utf8'));
      const entries = parsed?.entries || {};
      const insConv = db.prepare(
        'INSERT OR REPLACE INTO conv_cache(conv_id, sig, max_ts, archived, updated_at) VALUES (?, ?, ?, ?, ?)'
      );
      const insEv = db.prepare(
        'INSERT INTO usage_events(conv_id, ts, model_id, response_model, in_tok, cache_tok, out_tok) VALUES (?, ?, ?, ?, ?, ?, ?)'
      );
      db.exec('BEGIN');
      try {
        for (const [cid, entry] of Object.entries(entries)) {
          insConv.run(cid, entry?.sig || '', Number(entry?.maxTs) || 0, entry?.archived ? 1 : 0, now);
          for (const ev of entry?.rawEvents || []) {
            insEv.run(
              cid,
              Number(ev.ts) || 0,
              ev.modelId || '',
              ev.responseModel || '',
              Number(ev.inTok) || 0,
              Number(ev.cacheTok) || 0,
              Number(ev.outTok) || 0
            );
          }
        }
        db.exec('COMMIT');
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    } catch {}
  }
}

function loadQuotaHistory() {
  try {
    const db = getStatsDb();
    const row = db.prepare('SELECT value FROM kv_store WHERE key = ?').get('quota_history');
    if (row?.value) {
      const data = JSON.parse(row.value);
      if (data && typeof data === 'object' && data.accounts) return data;
    }
  } catch {}
  return { version: 3, sampleIntervalMs: SAMPLE_INTERVAL_MS, lastSampledAt: 0, accounts: {} };
}

function saveQuotaHistory(hist) {
  try {
    const db = getStatsDb();
    db.prepare(
      'INSERT OR REPLACE INTO kv_store(key, value, updated_at) VALUES (?, ?, ?)'
    ).run('quota_history', JSON.stringify(hist), Date.now());
  } catch (err) {
    console.error('[sidecar] Failed to save quota history to db:', err.message);
  }
}

// 无优惠官方标准 API 单价 ($ / 1M Tokens，不包含首发限时/Batch/区域折扣)
const STANDARD_MODEL_PRICING = {
  'gemini-4-neon': {
    key: 'gemini-4-neon',
    name: 'Gemini 4 Neon',
    input: 3.0,
    cacheRead: 0.15,
    output: 15.0,
    note: '标准原价',
  },
  'gemini-4-carbon': {
    key: 'gemini-4-carbon',
    name: 'Gemini 4 Carbon',
    input: 4.0,
    cacheRead: 0.2,
    output: 20.0,
    note: '标准原价 (无首发5折优惠)',
  },
  'gemini-4-argon': {
    key: 'gemini-4-argon',
    name: 'Gemini 4 Argon',
    input: 4.0,
    cacheRead: 0.2,
    output: 20.0,
    note: '标准原价 (无首发5折优惠)',
  },
  'gemini-4-hydrogen': {
    key: 'gemini-4-hydrogen',
    name: 'Gemini 4 Hydrogen',
    input: 1.5,
    cacheRead: 0.075,
    output: 7.5,
    note: '标准原价',
  },
  'gemini-flash': {
    key: 'gemini-flash',
    name: 'Gemini 3.8 / 3.x Flash',
    input: 1.5,
    cacheRead: 0.15,
    output: 7.5,
    note: '标准原价 (无首发5折优惠)',
  },
  'claude-opus-5-5': {
    key: 'claude-opus-5-5',
    name: 'Claude Opus 5.5',
    input: 4.0,
    cacheRead: 0.2,
    output: 20.0,
    note: '标准原价',
  },
  'claude-sonnet-5-5': {
    key: 'claude-sonnet-5-5',
    name: 'Claude Sonnet 5.5',
    input: 2.0,
    cacheRead: 0.1,
    output: 10.0,
    note: '标准原价',
  },
  'gpt-oss-120b': {
    key: 'gpt-oss-120b',
    name: 'GPT-OSS 120B',
    input: 0.15,
    cacheRead: 0.075,
    output: 0.6,
    note: '主流托管标准原价',
  },
};

const MODEL_PRICE_MATCHERS = [
  { re: /M53[2-5]|M537|neon/i, key: 'gemini-4-neon' },
  { re: /M427|M437|M438|M667|carbon/i, key: 'gemini-4-carbon' },
  { re: /M417|M418|M419|M681|argon/i, key: 'gemini-4-argon' },
  { re: /M52[5-8]|hydrogen/i, key: 'gemini-4-hydrogen' },
  { re: /M31[89]|M320|M298|M71|M264|M669|flash/i, key: 'gemini-flash' },
  { re: /M40[0-2]|opus/i, key: 'claude-opus-5-5' },
  { re: /M40[3-5]|sonnet/i, key: 'claude-sonnet-5-5' },
  { re: /GPT_OSS|gpt-oss/i, key: 'gpt-oss-120b' },
];

function resolveModelPricing(modelId, responseModel, label, poolKey) {
  const candidates = [modelId, label, responseModel];
  for (const cand of candidates) {
    if (!cand) continue;
    for (const rule of MODEL_PRICE_MATCHERS) {
      if (rule.re.test(cand)) return STANDARD_MODEL_PRICING[rule.key];
    }
  }
  return STANDARD_MODEL_PRICING[poolKey === '3p' ? 'claude-sonnet-5-5' : 'gemini-4-hydrogen'];
}

function classifyPoolKey(textOrModel) {
  if (!textOrModel) return 'gemini';
  return /M40[0-5]|GPT_OSS|claude|gpt|3p/i.test(textOrModel) ? '3p' : 'gemini';
}

function isNewQuotaCycle(prev, curr) {
  if (!prev) return false;
  if (prev.resetsAt == null && curr.resetsAt == null) {
    return curr.left > prev.left + 1;
  }
  if (prev.resetsAt == null || curr.resetsAt == null) return true;
  if (prev.resetsAt <= curr.at) return true;
  const moved = curr.resetsAt - prev.resetsAt;
  const elapsed = curr.at - prev.at;
  const rolling = moved > 0 && Math.abs(moved - elapsed) <= HIST_SLACK_MS;
  if (!rolling && Math.abs(moved) <= HIST_SLACK_MS && curr.left > prev.left + 1) {
    return true;
  }
  return moved > elapsed + HIST_SLACK_MS || moved < -HIST_SLACK_MS;
}

function getAllLocalConversationIds(summaries = {}) {
  const ids = new Set(Object.keys(summaries));
  const convDir = join(homedir(), '.gemini', 'antigravity', 'conversations');
  if (existsSync(convDir)) {
    try {
      for (const f of readdirSync(convDir)) {
        const clean = f.replace(/\.(pb|db|db-wal|db-shm)$/, '');
        if (clean) ids.add(clean);
      }
    } catch {}
  }
  const brainDir = join(homedir(), '.gemini', 'antigravity', 'brain');
  if (existsSync(brainDir)) {
    try {
      for (const d of readdirSync(brainDir)) {
        if (/^[0-9a-f-]{36}$/i.test(d)) ids.add(d);
      }
    } catch {}
  }
  return Array.from(ids);
}

function getConvDiskSignature(id, summaryInfo) {
  const convDir = join(homedir(), '.gemini', 'antigravity', 'conversations');
  const rpcTs = summaryInfo?.lastModifiedTime || summaryInfo?.createdTime || '';
  const parts = [rpcTs];
  for (const ext of ['.pb', '.db', '.db-wal']) {
    const p = join(convDir, `${id}${ext}`);
    if (existsSync(p)) {
      try {
        const st = statSync(p);
        // 仅当 .db-wal 非空时才把它的 mtime 计入签名（LS 启动时常会 touch 空的 0 字节 wal 文件）
        if (ext === '.db-wal' && st.size === 0) {
          parts.push('wal0');
        } else {
          parts.push(`${ext}:${st.size}:${Math.round(st.mtimeMs)}`);
        }
      } catch {}
    }
  }
  return parts.join('|');
}

async function collectWindowUsageEvents(sinceMs, modelMap = {}) {
  const events = [];
  let totalConversations = 0;
  try {
    const db = getStatsDb();
    const all = await callRpc('GetAllCascadeTrajectories', {});
    const summaries = all?.trajectorySummaries || {};
    const allIds = getAllLocalConversationIds(summaries);
    const liveIdSet = new Set(allIds);

    const existingRows = db.prepare('SELECT conv_id, sig, max_ts, archived FROM conv_cache').all();
    const existingMap = new Map(existingRows.map((r) => [r.conv_id, r]));
    const toFetch = [];

    for (const id of allIds) {
      const sig = getConvDiskSignature(id, summaries[id]);
      const cached = existingMap.get(id);
      if (!cached || cached.sig !== sig || cached.archived) {
        toFetch.push({ id, sig });
      }
    }

    // 将磁盘已删除的会话在 DB 中标记 archived=1，其 usage_events 永久保留在 SQLite 中不丢失
    const markArchived = db.prepare('UPDATE conv_cache SET archived = 1, updated_at = ? WHERE conv_id = ?');
    const now = Date.now();
    for (const row of existingRows) {
      if (!liveIdSet.has(row.conv_id) && !row.archived) {
        markArchived.run(now, row.conv_id);
      }
    }

    if (toFetch.length > 0) {
      const upsertConv = db.prepare(
        'INSERT OR REPLACE INTO conv_cache(conv_id, sig, max_ts, archived, updated_at) VALUES (?, ?, ?, ?, ?)'
      );
      const delEv = db.prepare('DELETE FROM usage_events WHERE conv_id = ?');
      const insEv = db.prepare(
        'INSERT INTO usage_events(conv_id, ts, model_id, response_model, in_tok, cache_tok, out_tok) VALUES (?, ?, ?, ?, ?, ?, ?)'
      );
      const countEv = db.prepare('SELECT COUNT(*) AS c FROM usage_events WHERE conv_id = ?');

      const BATCH_SIZE = 12;
      for (let i = 0; i < toFetch.length; i += BATCH_SIZE) {
        const batch = toFetch.slice(i, i + BATCH_SIZE);
        const results = await Promise.all(
          batch.map((item) => callRpc('GetCascadeTrajectory', { cascade_id: item.id }).catch(() => null))
        );
        const tsNow = Date.now();
        db.exec('BEGIN');
        try {
          for (let j = 0; j < batch.length; j++) {
            const { id, sig } = batch[j];
            const traj = results[j]?.trajectory;
            if (!traj) {
              const prevCnt = countEv.get(id)?.c || 0;
              if (prevCnt > 0) {
                markArchived.run(tsNow, id);
                continue;
              }
              upsertConv.run(id, sig, 0, 0, tsNow);
              continue;
            }
            const steps = traj.steps || [];
            const gens = traj.generatorMetadata || [];
            const fallbackTs = parseIsoMs(traj.metadata?.createdAt);
            let maxTs = 0;
            delEv.run(id);
            for (const gen of gens) {
              const cm = gen.chatModel || {};
              const u = cm.usage;
              if (!u) continue;
              const stepIdx = gen.stepIndices?.[0] ?? 0;
              const st = steps[stepIdx] || steps[Math.max(0, stepIdx - 1)];
              const ts = parseIsoMs(st?.metadata?.createdAt) ?? fallbackTs;
              if (ts == null) continue;
              if (ts > maxTs) maxTs = ts;
              insEv.run(
                id,
                ts,
                cm.model || u.model || cm.responseModel || '',
                cm.responseModel || '',
                Number(u.inputTokens) || 0,
                Number(u.cacheReadTokens) || 0,
                Number(u.outputTokens) || 0
              );
            }
            upsertConv.run(id, sig, maxTs, 0, tsNow);
          }
          db.exec('COMMIT');
        } catch (err) {
          db.exec('ROLLBACK');
          throw err;
        }
      }
    }

    totalConversations = db.prepare('SELECT COUNT(*) AS c FROM conv_cache').get()?.c || 0;
    const rows = db
      .prepare(
        'SELECT conv_id, ts, model_id, response_model, in_tok, cache_tok, out_tok FROM usage_events WHERE ts >= ?'
      )
      .all(sinceMs);

    for (const r of rows) {
      const pool = classifyPoolKey(r.model_id || r.response_model);
      const label = resolveModelLabel(r.model_id, r.response_model, modelMap);
      const pricing = resolveModelPricing(r.model_id, r.response_model, label, pool);

      const inputUsd = (r.in_tok * pricing.input) / 1e6;
      const cacheUsd = (r.cache_tok * pricing.cacheRead) / 1e6;
      const outputUsd = (r.out_tok * pricing.output) / 1e6;

      events.push({
        ts: r.ts,
        convId: r.conv_id,
        pool,
        modelKey: pricing.key,
        modelName: pricing.name,
        unitPrice: { input: pricing.input, cacheRead: pricing.cacheRead, output: pricing.output },
        nonCache: r.in_tok + r.out_tok,
        total: r.in_tok + r.cache_tok + r.out_tok,
        output: r.out_tok,
        inputUsd,
        cacheUsd,
        outputUsd,
        costUsd: inputUsd + cacheUsd + outputUsd,
      });
    }
  } catch (err) {
    console.error('[sidecar] Error collecting window usage events:', err.message);
  }
  events.totalConversations = totalConversations;
  return events;
}

function summarizeWindowUsage(events, poolKey, startMs, endMs) {
  let nonCache = 0;
  let total = 0;
  let output = 0;
  let calls = 0;
  let costUsd = 0;
  let inputUsd = 0;
  let cacheUsd = 0;
  let outputUsd = 0;
  const sessionIds = new Set();
  const byModelMap = new Map();

  for (const e of events) {
    if (e.pool === poolKey && e.ts >= startMs && e.ts <= endMs) {
      if (e.convId) sessionIds.add(e.convId);
      nonCache += e.nonCache;
      total += e.total;
      output += e.output;
      calls += 1;
      costUsd += e.costUsd || 0;
      inputUsd += e.inputUsd || 0;
      cacheUsd += e.cacheUsd || 0;
      outputUsd += e.outputUsd || 0;

      const mKey = e.modelKey || e.modelName || 'unknown';
      if (!byModelMap.has(mKey)) {
        byModelMap.set(mKey, {
          key: mKey,
          name: e.modelName || mKey,
          calls: 0,
          costUsd: 0,
          nonCache: 0,
          unitPrice: e.unitPrice || null,
        });
      }
      const entry = byModelMap.get(mKey);
      entry.calls += 1;
      entry.costUsd += e.costUsd || 0;
      entry.nonCache += e.nonCache;
    }
  }

  const byModel = Array.from(byModelMap.values())
    .map((m) => ({ ...m, costUsd: Number(m.costUsd.toFixed(4)) }))
    .sort((a, b) => b.costUsd - a.costUsd);

  return {
    nonCache,
    total,
    output,
    calls,
    sessionCount: sessionIds.size,
    costUsd: Number(costUsd.toFixed(4)),
    inputUsd: Number(inputUsd.toFixed(4)),
    cacheUsd: Number(cacheUsd.toFixed(4)),
    outputUsd: Number(outputUsd.toFixed(4)),
    byModel,
  };
}

function appendQuotaPoint(bucketHist, pt) {
  const pts = bucketHist.points || (bucketHist.points = []);
  const intervals = bucketHist.intervals || (bucketHist.intervals = []);
  const prev = pts[pts.length - 1];

  // 记录 15 分钟级别有效消耗区间，用于跨周期测算 API 窗口总额 ($)
  if (prev && !isNewQuotaCycle(prev, pt)) {
    const deltaLeft = prev.left - pt.left;
    const deltaNonCache = pt.winNonCache - (prev.winNonCache ?? 0);
    const deltaTotal = pt.winTotal - (prev.winTotal ?? 0);
    const deltaCalls = pt.winCalls - (prev.winCalls ?? 0);
    const hasCostDelta = prev.winCostUsd != null && pt.winCostUsd != null;
    const deltaCostUsd = hasCostDelta ? pt.winCostUsd - prev.winCostUsd : 0;

    if (deltaLeft > 0.005 && (deltaNonCache > 0 || deltaCostUsd > 0) && pt.at > prev.at) {
      intervals.push({
        fromAt: prev.at,
        toAt: pt.at,
        deltaUsedPct: Number(deltaLeft.toFixed(5)),
        deltaCostUsd: hasCostDelta ? Number(Math.max(0, deltaCostUsd).toFixed(6)) : null,
        deltaNonCache,
        deltaTotal: Math.max(deltaNonCache, deltaTotal),
        deltaCalls: Math.max(1, deltaCalls),
      });
      if (intervals.length > HIST_MAX_INTERVALS) {
        intervals.splice(0, intervals.length - HIST_MAX_INTERVALS);
      }
    }
  }

  // Magpie 风格平坦段合并：连续 3 个点余量无变化且处于同一周期时原地更新末点时间与累计用量
  if (pts.length >= 2) {
    const prev2 = pts[pts.length - 2];
    if (
      !isNewQuotaCycle(prev, pt) &&
      !isNewQuotaCycle(prev2, prev) &&
      Math.abs(prev.left - pt.left) < 0.0001 &&
      Math.abs(prev2.left - prev.left) < 0.0001
    ) {
      pts[pts.length - 1] = pt;
      return;
    }
  }
  pts.push(pt);
}

function pruneBucketHistory(bucketHist, now) {
  const cutoff = now - HIST_KEPT_MS;
  if (Array.isArray(bucketHist.points)) {
    bucketHist.points = bucketHist.points.filter((p) => p.at >= cutoff).slice(-HIST_MAX_POINTS);
  }
  if (Array.isArray(bucketHist.intervals)) {
    bucketHist.intervals = bucketHist.intervals
      .filter((iv) => iv.toAt >= cutoff)
      .slice(-HIST_MAX_INTERVALS);
  }
}

let samplingPromise = null;

async function sampleQuotaWindows({ force = false, summaryData = null, accountEmail = '' } = {}) {
  if (samplingPromise) return samplingPromise;
  samplingPromise = (async () => {
    const now = Date.now();
    const hist = loadQuotaHistory();
    const elapsedSinceLast = now - (hist.lastSampledAt || 0);

    const summary = summaryData || (await callRpc('RetrieveUserQuotaSummary', {}).catch(() => null));
    const groups = summary?.response?.groups || [];
    if (groups.length === 0) {
      return { hist, summary, sampled: false };
    }

    let email = accountEmail;
    if (!email) {
      const acctKeys = Object.keys(hist.accounts || {});
      email = acctKeys[0] || 'default';
    }
    const acctKey = email.toLowerCase();
    if (!hist.accounts[acctKey]) hist.accounts[acctKey] = { buckets: {} };
    const bucketsHist = hist.accounts[acctKey].buckets;

    // 判断是否到达 15 分钟采样周期，或是否首次采样 / 升级结构 / 余量发生明显变化 / 周期重置
    let shouldRecord =
      force || hist.version !== 3 || !hist.lastSampledAt || elapsedSinceLast >= SAMPLE_INTERVAL_MS;
    if (!shouldRecord) {
      for (const g of groups) {
        for (const b of g.buckets || []) {
          if (b.disabled) continue;
          const bHist = bucketsHist[b.bucketId];
          const prev = bHist?.points?.[bHist.points.length - 1];
          const left = Number(((b.remainingFraction ?? 1) * 100).toFixed(5));
          const resetsAt = parseIsoMs(b.resetTime);
          if (!prev || isNewQuotaCycle(prev, { at: now, left, resetsAt }) || Math.abs(prev.left - left) >= 0.05) {
            shouldRecord = true;
            break;
          }
        }
        if (shouldRecord) break;
      }
    }

    const modelMap = await getModelLabelMap().catch(() => cachedModelMap);
    const events = await collectWindowUsageEvents(now - 8 * 24 * 3600 * 1000, modelMap);

    if (shouldRecord) {
      for (const g of groups) {
        const poolKey = classifyPoolKey(g.displayName);
        for (const b of g.buckets || []) {
          if (b.disabled) continue;
          const spanMs = b.window === '5h' ? 5 * 3600 * 1000 : 7 * 24 * 3600 * 1000;
          const resetsAt = parseIsoMs(b.resetTime);
          const start = resetsAt ? resetsAt - spanMs : now;
          const left = Number(((b.remainingFraction ?? 1) * 100).toFixed(5));
          const usage = summarizeWindowUsage(events, poolKey, start, now);

          if (!bucketsHist[b.bucketId]) {
            bucketsHist[b.bucketId] = {
              displayName: b.displayName || b.bucketId,
              pool: g.displayName,
              window: b.window,
              spanMs,
              points: [],
              intervals: [],
            };
          }
          const bHist = bucketsHist[b.bucketId];
          bHist.displayName = b.displayName || b.bucketId;
          bHist.pool = g.displayName;
          bHist.window = b.window;
          bHist.spanMs = spanMs;

          appendQuotaPoint(bHist, {
            at: now,
            left,
            start,
            resetsAt,
            winCostUsd: usage.costUsd,
            winNonCache: usage.nonCache,
            winTotal: usage.total,
            winOutput: usage.output,
            winCalls: usage.calls,
          });
          pruneBucketHistory(bHist, now);
        }
      }
      hist.version = 3;
      hist.lastSampledAt = now;
      hist.sampleIntervalMs = SAMPLE_INTERVAL_MS;
      saveQuotaHistory(hist);
    }

    return { hist, summary, events, sampled: shouldRecord, accountKey: acctKey };
  })();

  try {
    return await samplingPromise;
  } finally {
    samplingPromise = null;
  }
}

function computeWindowAnalytics(group, bucket, bHist, events, now) {
  const poolKey = classifyPoolKey(group.displayName);
  const spanMs = bucket.window === '5h' ? 5 * 3600 * 1000 : 7 * 24 * 3600 * 1000;
  const resetsAt = parseIsoMs(bucket.resetTime);
  const start = resetsAt ? resetsAt - spanMs : now;
  const leftRaw = Math.min(100, Math.max(0, (bucket.remainingFraction ?? 1) * 100));
  const usedRaw = Math.max(0, 100 - leftRaw);
  const left = leftRaw > 0 && leftRaw < 10 ? Number(leftRaw.toFixed(2)) : Number(leftRaw.toFixed(1));
  const used = usedRaw > 0 && usedRaw < 10 ? Number(usedRaw.toFixed(2)) : Number(usedRaw.toFixed(1));

  // Magpie Pace 计算: used - even
  let pace = null;
  if (resetsAt && resetsAt > start && now >= start && now < resetsAt) {
    const even = (100 * (now - start)) / (resetsAt - start);
    pace = Math.round(usedRaw - even);
  }

  // 提取当前周期与近2天的采样点
  const allPts = Array.isArray(bHist?.points) ? bHist.points : [];
  let cycleIdx = allPts.length - 1;
  while (cycleIdx > 0 && !isNewQuotaCycle(allPts[cycleIdx - 1], allPts[cycleIdx])) {
    cycleIdx--;
  }
  const cyclePoints = cycleIdx >= 0 ? allPts.slice(cycleIdx) : [];
  const cycleStart = cyclePoints[0]?.start ?? start;

  // Magpie quotaEta 线性拟合耗尽预测
  let eta = null;
  if (cyclePoints.length >= 3 && leftRaw > 0) {
    let i = cyclePoints.length - 1;
    while (i > 0 && cyclePoints[i - 1].left >= cyclePoints[i].left && now - cyclePoints[i - 1].at <= 7 * 86400e3) {
      i--;
    }
    const fitPts = cyclePoints.slice(i);
    const spanFit = fitPts.length >= 2 ? fitPts[fitPts.length - 1].at - fitPts[0].at : 0;
    if (fitPts.length >= 3 && spanFit >= 25 * 60 * 1000) {
      const t0 = fitPts[0].at;
      const n = fitPts.length;
      let sx = 0, sy = 0, sxx = 0, sxy = 0;
      for (const p of fitPts) {
        const x = (p.at - t0) / 86400e3;
        sx += x;
        sy += p.left;
        sxx += x * x;
        sxy += x * p.left;
      }
      const den = n * sxx - sx * sx;
      if (den > 0) {
        const slope = (n * sxy - sx * sy) / den; // % per day
        if (slope < -0.05) {
          const intercept = (sy - slope * sx) / n;
          const outAt = Math.round(t0 + (-intercept / slope) * 86400e3);
          if (outAt > now) {
            eta = {
              outAt,
              lastsUntilReset: resetsAt ? outAt >= resetsAt : false,
              burnPctPerHour: Number((-slope / 24).toFixed(2)),
            };
          }
        } else {
          eta = { outAt: null, lastsUntilReset: true, burnPctPerHour: 0 };
        }
      }
    }
  }

  // 当前窗口实际观测消耗
  const currentUsage = summarizeWindowUsage(events || [], poolKey, start, now);

  // 5h & 1week API 窗口总额度测算 ($ USD，按无优惠标准 API 单价计算)
  // 优先使用 15 分钟采样区间累积 (ΣΔcostUsd / ΣΔusedFrac)，不足时回退至当前窗口轨迹总消费推算
  const intervals = Array.isArray(bHist?.intervals) ? bHist.intervals : [];
  let sumUsedPctCost = 0;
  let sumCostUsd = 0;
  let costIntervalCount = 0;
  let sumUsedPctTok = 0;
  let sumNonCache = 0;
  let sumTotal = 0;
  let sumCalls = 0;
  for (const iv of intervals) {
    sumUsedPctTok += iv.deltaUsedPct;
    sumNonCache += iv.deltaNonCache;
    sumTotal += iv.deltaTotal;
    sumCalls += iv.deltaCalls;
    if (iv.deltaCostUsd != null && iv.deltaCostUsd > 0) {
      sumUsedPctCost += iv.deltaUsedPct;
      sumCostUsd += iv.deltaCostUsd;
      costIntervalCount += 1;
    }
  }

  let estApiUsd = null;
  let estNonCache = null;
  let estTotal = null;
  let estCalls = null;
  let source = 'insufficient';
  let usedIntervalCount = intervals.length;

  if (costIntervalCount >= 1 && sumUsedPctCost >= 0.01 && sumCostUsd > 0) {
    const fracCost = sumUsedPctCost / 100;
    estApiUsd = Number((sumCostUsd / fracCost).toFixed(2));
    const fracTok = sumUsedPctTok / 100;
    estNonCache = fracTok > 0 ? Math.round(sumNonCache / fracTok) : null;
    estTotal = fracTok > 0 ? Math.round(sumTotal / fracTok) : null;
    estCalls = fracTok > 0 ? Math.round(sumCalls / fracTok) : null;
    source = '15m_intervals';
    usedIntervalCount = costIntervalCount;
  } else if (usedRaw >= 0.05 && currentUsage.costUsd > 0) {
    const frac = usedRaw / 100;
    estApiUsd = Number((currentUsage.costUsd / frac).toFixed(2));
    estNonCache = Math.round(currentUsage.nonCache / frac);
    estTotal = Math.round(currentUsage.total / frac);
    estCalls = Math.round(currentUsage.calls / frac);
    source = 'window_trajectories';
  }

  const remainingApiUsd = estApiUsd != null ? Number((estApiUsd * (leftRaw / 100)).toFixed(2)) : null;
  const remainingNonCache = estNonCache != null ? Math.round(estNonCache * (leftRaw / 100)) : null;
  const remainingCalls = estCalls != null ? Math.round(estCalls * (leftRaw / 100)) : null;

  return {
    bucketId: bucket.bucketId,
    window: bucket.window,
    label: bucket.window === '5h' ? '5 小时 API 窗口' : bucket.window === 'weekly' ? '7 天 (1week) API 窗口' : bucket.displayName,
    shortLabel: bucket.window === '5h' ? '5 小时' : bucket.window === 'weekly' ? '7 天' : bucket.displayName,
    left,
    used,
    start: cycleStart,
    resetsAt,
    spanMs,
    pace,
    eta,
    currentUsage,
    estimate: {
      source,
      intervalCount: usedIntervalCount,
      pointCount: cyclePoints.length,
      totalApiUsd: estApiUsd,
      remainingApiUsd,
      totalNonCacheTokens: estNonCache,
      totalAllTokens: estTotal,
      totalCalls: estCalls,
      remainingNonCacheTokens: remainingNonCache,
      remainingCalls,
    },
    points: allPts
      .filter((p) => p.at >= now - 8 * 24 * 3600 * 1000)
      .slice(-300)
      .map((p) => ({ at: p.at, left: p.left, start: p.start, resetsAt: p.resetsAt })),
  };
}

async function buildQuotaPayload({ forceSample = false } = {}) {
  const [raw, summary] = await Promise.all([
    callRpc('GetUserStatus', { metadata: {} }),
    callRpc('RetrieveUserQuotaSummary', {}).catch(() => null),
  ]);
  const us = raw.userStatus || {};
  const ps = us.planStatus || {};
  const planInfo = ps.planInfo || {};
  const cfgs = (us.cascadeModelConfigData && us.cascadeModelConfigData.clientModelConfigs) || [];

  updateModelMapFromConfigs(cfgs);

  const sampleResult = await sampleQuotaWindows({
    force: forceSample,
    summaryData: summary,
    accountEmail: us.email || '',
  });
  const now = Date.now();
  const hist = sampleResult.hist || loadQuotaHistory();
  const acctKey = (us.email || Object.keys(hist.accounts || {})[0] || 'default').toLowerCase();
  const bucketsHist = hist.accounts?.[acctKey]?.buckets || {};
  const events =
    sampleResult.events ||
    (await collectWindowUsageEvents(now - 8 * 24 * 3600 * 1000, cachedModelMap));

  const windowGroups = (summary?.response?.groups || []).map((g) => ({
    id: classifyPoolKey(g.displayName),
    displayName: g.displayName,
    description: g.description || '',
    windows: (g.buckets || [])
      .filter((b) => !b.disabled)
      .sort((a, b) => (a.window === '5h' ? -1 : b.window === '5h' ? 1 : 0))
      .map((b) => computeWindowAnalytics(g, b, bucketsHist[b.bucketId], events, now)),
  }));

  const perModel = cfgs
    .map((c) => ({
      label: c.label || c.modelOrAlias?.model || c.model || 'Unknown',
      model: c.modelOrAlias?.model || c.model || '',
      quota: c.quotaInfo,
    }))
    .filter((c) => c.quota);

  const fracs = perModel
    .map((c) => c.quota.remainingFraction)
    .filter((v) => typeof v === 'number');

  const minFrac = fracs.length ? Math.min(...fracs) : null;
  const minCfg = perModel.find((c) => c.quota.remainingFraction === minFrac);

  const poolMap = new Map();
  for (const c of perModel) {
    const pct = toQuotaPercent(c.quota.remainingFraction);
    const resetTime = c.quota.resetTime || '';
    const key = `${resetTime}__${pct}`;
    if (!poolMap.has(key)) {
      poolMap.set(key, { remainingFraction: pct, resetTime: resetTime || null, models: [] });
    }
    poolMap.get(key).models.push(c.label);
  }
  const quotaPools = Array.from(poolMap.values())
    .map((pool) => {
      const first = pool.models[0] || '模型池';
      const hasClaude = pool.models.some((m) => /claude/i.test(m));
      const hasGemini = pool.models.some((m) => /gemini/i.test(m));
      let poolName = first;
      if (hasGemini && !hasClaude) poolName = 'Gemini / Orchestrator 池';
      else if (hasClaude) poolName = 'Claude / GPT-OSS 池';
      return {
        name: poolName,
        remainingFraction: pool.remainingFraction,
        resetTime: pool.resetTime,
        modelCount: pool.models.length,
        sampleModels: pool.models.slice(0, 3),
      };
    })
    .sort((a, b) => a.remainingFraction - b.remainingFraction);

  const userTier = us.userTier || {};
  return {
    success: true,
    name: us.name || '',
    email: us.email || '',
    plan: planInfo.planName || 'Pro',
    teamsTier: planInfo.teamsTier || 'TEAMS_TIER_PRO',
    planDesc: `商业层级为 ${planInfo.planName || 'Pro'}`,
    userTierName: userTier.name || 'Google AI Pro',
    userTierId: userTier.id || 'g1-pro-tier',
    userTierDesc: userTier.description || 'Google One AI 高级订阅权益',
    upgradeText: userTier.upgradeSubscriptionText || '可升级至 Google AI Ultra 获取更高额度',
    maxChatInputTokens: Number(planInfo.maxNumChatInputTokens) || 16384,
    remainingFraction: minFrac != null ? toQuotaPercent(minFrac) : 100,
    mostConstrainedModel: minCfg ? minCfg.label : null,
    resetTime: (minCfg && minCfg.quota.resetTime) || null,
    promptCredits: {
      available: ps.availablePromptCredits ?? 0,
      monthly: planInfo.monthlyPromptCredits ?? null,
    },
    flowCredits: {
      available: ps.availableFlowCredits ?? 0,
      monthly: planInfo.monthlyFlowCredits ?? null,
    },
    quotaPools,
    quotaEstimate: {
      unit: 'USD',
      pricingBasis: 'standard_no_discount',
      totalSessionsScanned: events.totalConversations || 0,
      sampleIntervalMin: Math.round(SAMPLE_INTERVAL_MS / 60000),
      lastSampledAt: hist.lastSampledAt || null,
      nextSampleAt: hist.lastSampledAt ? hist.lastSampledAt + SAMPLE_INTERVAL_MS : null,
      pricingSchedule: Object.values(STANDARD_MODEL_PRICING),
      groups: windowGroups,
    },
    modelQuotas: perModel.map((c) => ({
      label: c.label,
      model: c.model,
      remainingFraction: toQuotaPercent(c.quota.remainingFraction),
      resetTime: c.quota.resetTime || null,
    })),
  };
}

// GET /api/quota: 获取用户状态、套餐、额度与 5h/1week 测算窗口
app.api('/api/quota', async () => {
  try {
    return await buildQuotaPayload({ forceSample: false });
  } catch (err) {
    return { success: false, error: err.message };
  }
}, 'GET');

// POST /api/quota/sample: 立即执行一次配额采样与 5h/1week 总量重算
app.api('/api/quota/sample', async () => {
  try {
    return await buildQuotaPayload({ forceSample: true });
  } catch (err) {
    return { success: false, error: err.message };
  }
}, 'POST');

const handleConversation = async (data) => {
  const conversationId = data?.conversationId || data?.id;
  if (!conversationId) {
    return { success: false, error: '缺少 conversationId 参数' };
  }

  try {
    const [raw, modelMap] = await Promise.all([
      callRpc('GetCascadeTrajectory', { cascade_id: conversationId }),
      getModelLabelMap(),
    ]);
    const traj = raw.trajectory || {};
    const gens = traj.generatorMetadata || [];
    const steps = traj.steps || [];

    let input = 0;
    let cache = 0;
    let output = 0;
    let responseOutput = 0;
    let thinking = 0;
    let ctxUsed = 0;
    let ctxMax = 0;
    let ctxPeak = 0;
    let calls = 0;
    let retries = 0;
    let latestBreakdown = null;

    const models = {};
    const modelDetails = {};
    const ttfts = [];
    const streamSecs = [];
    const totalLatSecs = [];
    const validStreamTpsList = [];
    const steadyStreamTpsList = [];
    let validStreamOutSum = 0;
    let validStreamSecSum = 0;
    let e2eOutSum = 0;
    let e2eElapsedSum = 0;
    let lastTtft = null;
    let lastTps = null;
    const recentCalls = [];

    for (const gen of gens) {
      const cm = gen.chatModel || {};
      const u = cm.usage || {};
      if (!u.inputTokens && !u.outputTokens) continue;

      calls++;
      const inTok = Number(u.inputTokens) || 0;
      const cacheTok = Number(u.cacheReadTokens) || 0;
      const outTok = Number(u.outputTokens) || 0;
      const thinkTok = Number(u.thinkingOutputTokens) || 0;
      const respTok =
        u.responseOutputTokens != null
          ? Number(u.responseOutputTokens) || 0
          : Math.max(0, outTok - thinkTok);

      input += inTok;
      cache += cacheTok;
      output += outTok;
      responseOutput += respTok;
      thinking += thinkTok;

      const callRetries = Array.isArray(cm.retryInfos) && cm.retryInfos.length > 1
        ? cm.retryInfos.length - 1
        : 0;
      retries += callRetries;

      const ttftSec = parseSeconds(cm.timeToFirstToken);
      if (ttftSec != null) {
        ttfts.push(ttftSec);
        lastTtft = ttftSec;
      }

      const streamSec = parseSeconds(cm.streamingDuration);
      let callTps = null;
      let tpsBuffered = false;
      let isValidStream = false;
      if (streamSec != null && streamSec > 0) {
        streamSecs.push(streamSec);
        const totalElapsed = ttftSec != null ? ttftSec + streamSec : streamSec;
        if (ttftSec != null) totalLatSecs.push(totalElapsed);
        if (outTok > 0) {
          e2eOutSum += outTok;
          e2eElapsedSum += totalElapsed;
          const rawStreamTps = outTok / streamSec;
          // 过滤服务端缓冲/工具调用瞬时刷盘导致的虚高流式 TPS（例如 ttft=28s, stream=0.7s, out=7753）
          const looksBuffered =
            streamSec < 0.5 ||
            rawStreamTps > 800 ||
            (ttftSec != null && rawStreamTps > 450 && streamSec < ttftSec * 0.2);

          if (!looksBuffered) {
            isValidStream = true;
            callTps = Number(rawStreamTps.toFixed(1));
            validStreamOutSum += outTok;
            validStreamSecSum += streamSec;
            validStreamTpsList.push(callTps);
            if (streamSec >= 1.0 && outTok >= 50) {
              steadyStreamTpsList.push(callTps);
            }
            lastTps = callTps;
          } else if (totalElapsed > 0) {
            tpsBuffered = true;
            callTps = Number((outTok / totalElapsed).toFixed(1));
            lastTps = callTps;
          }
        }
      }

      const rawModelId = cm.model || u.model || cm.responseModel || '';
      const modelName = resolveModelLabel(cm.model || u.model, cm.responseModel, modelMap);
      const poolKey = classifyPoolKey(rawModelId || modelName);
      const pricing = resolveModelPricing(rawModelId, cm.responseModel, modelName, poolKey);
      const callCostUsd =
        (inTok * pricing.input + cacheTok * pricing.cacheRead + outTok * pricing.output) / 1e6;

      const callSum = inTok + cacheTok + outTok;
      models[modelName] = (models[modelName] || 0) + callSum;
      if (!modelDetails[modelName]) {
        modelDetails[modelName] = {
          calls: 0,
          input: 0,
          cache: 0,
          output: 0,
          responseOutput: 0,
          thinking: 0,
          total: 0,
          costUsd: 0,
          _streamOut: 0,
          _streamSec: 0,
        };
      }
      const md = modelDetails[modelName];
      md.calls += 1;
      md.input += inTok;
      md.cache += cacheTok;
      md.output += outTok;
      md.responseOutput += respTok;
      md.thinking += thinkTok;
      md.total += callSum;
      md.costUsd += callCostUsd;
      if (isValidStream) {
        md._streamOut += outTok;
        md._streamSec += streamSec;
      }

      const cwm = cm.chatStartMetadata?.contextWindowMetadata || {};
      const cu = Number(cwm.estimatedTokensUsed) || 0;
      const cx = Number(cwm.maxContextTokens) || 0;
      if (cu > 0) {
        ctxUsed = cu;
        if (cu > ctxPeak) ctxPeak = cu;
      }
      if (cx > 0) ctxMax = cx;
      if (cwm.tokenBreakdown?.groups) {
        latestBreakdown = cwm.tokenBreakdown;
      }

      recentCalls.push({
        model: modelName,
        input: inTok,
        cache: cacheTok,
        output: outTok,
        responseOutput: respTok,
        thinking: thinkTok,
        ttftMs: ttftSec != null ? Math.round(ttftSec * 1000) : null,
        streamMs: streamSec != null ? Math.round(streamSec * 1000) : null,
        tps: callTps,
        tpsBuffered,
        retries: callRetries,
      });
    }

    // 整理分模型明细（输出精确 costUsd 与各自有效流式 TPS）
    for (const md of Object.values(modelDetails)) {
      md.costUsd = Number(md.costUsd.toFixed(4));
      md.tpsAvg = md._streamSec > 0 && md._streamOut > 0 ? Number((md._streamOut / md._streamSec).toFixed(1)) : null;
      delete md._streamOut;
      delete md._streamSec;
    }

    // 统计工具调用分布、耗时、用户轮次与错误步骤
    let toolCalls = 0;
    let userTurns = 0;
    let plannerSteps = 0;
    let errorSteps = 0;
    let runningSteps = 0;
    let minStepMs = parseIsoMs(traj.metadata?.createdAt);
    let maxStepMs = minStepMs;
    const toolMap = new Map();

    const recordTool = (name, durMs, isErr) => {
      if (!name) return;
      toolCalls++;
      if (!toolMap.has(name)) {
        toolMap.set(name, { name, count: 0, errors: 0, totalMs: 0, timedCount: 0 });
      }
      const entry = toolMap.get(name);
      entry.count += 1;
      if (isErr) entry.errors += 1;
      if (durMs != null && durMs >= 0) {
        entry.totalMs += durMs;
        entry.timedCount += 1;
      }
    };

    for (const st of steps) {
      if (st.type === 'CORTEX_STEP_TYPE_USER_INPUT') userTurns++;
      else if (st.type === 'CORTEX_STEP_TYPE_PLANNER_RESPONSE') plannerSteps++;

      const isErr = st.status === 'CORTEX_STEP_STATUS_ERROR' || st.status === 'CORTEX_STEP_STATUS_FAILED';
      if (isErr) errorSteps++;
      if (st.status === 'CORTEX_STEP_STATUS_RUNNING') runningSteps++;

      const md = st.metadata || {};
      const cMs = parseIsoMs(md.createdAt);
      const sMs = parseIsoMs(md.startedAt);
      const eMs = parseIsoMs(md.completedAt);
      for (const ts of [cMs, sMs, eMs]) {
        if (ts != null) {
          if (minStepMs == null || ts < minStepMs) minStepMs = ts;
          if (maxStepMs == null || ts > maxStepMs) maxStepMs = ts;
        }
      }

      if (md.toolCall?.name) {
        const durMs = sMs != null && eMs != null ? eMs - sMs : null;
        recordTool(md.toolCall.name, durMs, isErr);
      } else if (Array.isArray(md.toolCalls)) {
        for (const tc of md.toolCalls) {
          recordTool(tc?.name || 'unknown', null, isErr);
        }
      }
    }

    const toolBreakdown = Array.from(toolMap.values())
      .map((t) => ({
        name: t.name,
        count: t.count,
        errors: t.errors,
        totalMs: Math.round(t.totalMs),
        avgMs: t.timedCount > 0 ? Math.round(t.totalMs / t.timedCount) : null,
      }))
      .sort((a, b) => b.count - a.count);

    // 上下文拆解
    let contextBreakdown = null;
    if (latestBreakdown?.groups) {
      contextBreakdown = {
        totalTokens: Number(latestBreakdown.totalTokens) || ctxUsed,
        groups: latestBreakdown.groups.map((g) => ({
          name: g.name,
          type: g.type,
          numTokens: Number(g.numTokens) || 0,
          children: Array.isArray(g.children)
            ? [...g.children]
                .map((ch) => ({ name: ch.name, numTokens: Number(ch.numTokens) || 0 }))
                .sort((a, b) => b.numTokens - a.numTokens)
                .slice(0, 6)
            : [],
        })),
      };
    }

    // 计算 TTFT / 流式 / TPS 统计
    const sorted = [...ttfts].sort((a, b) => a - b);
    const at = (arr, p) =>
      arr.length ? arr[Math.min(arr.length - 1, Math.floor(arr.length * p))] : null;
    const avgOf = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null);

    const avgTtft = avgOf(sorted);
    const avgStream = avgOf(streamSecs);
    const totalStreamSec = streamSecs.reduce((a, b) => a + b, 0);
    const avgTotalLat = avgOf(totalLatSecs);
    const avgTps =
      validStreamSecSum > 0 && validStreamOutSum > 0
        ? validStreamOutSum / validStreamSecSum
        : e2eElapsedSum > 0 && e2eOutSum > 0
          ? e2eOutSum / e2eElapsedSum
          : null;
    const peakSource = steadyStreamTpsList.length ? steadyStreamTpsList : validStreamTpsList;
    const peakTps = peakSource.length ? Math.max(...peakSource) : avgTps;

    const totalTokens = input + cache + output;
    const contextPercent = ctxMax > 0 ? Number(((ctxUsed / ctxMax) * 100).toFixed(1)) : 0;
    const durationSec =
      minStepMs != null && maxStepMs != null && maxStepMs >= minStepMs
        ? Math.round((maxStepMs - minStepMs) / 1000)
        : null;

    return {
      success: true,
      conversationId,
      callsCount: calls,
      stepsCount: raw.numTotalSteps != null ? raw.numTotalSteps : steps.length,
      toolCallsCount: toolCalls,
      tokens: {
        input,
        cache,
        output,
        responseOutput,
        thinking,
        total: totalTokens,
      },
      context: {
        used: ctxUsed,
        max: ctxMax,
        peak: ctxPeak,
        percent: contextPercent,
      },
      contextBreakdown,
      latency: {
        lastMs: lastTtft != null ? Math.round(lastTtft * 1000) : null,
        p50Ms: at(sorted, 0.5) != null ? Math.round(at(sorted, 0.5) * 1000) : null,
        p90Ms: at(sorted, 0.9) != null ? Math.round(at(sorted, 0.9) * 1000) : null,
        avgMs: avgTtft != null ? Math.round(avgTtft * 1000) : null,
        samples: sorted.length,
        streamAvgMs: avgStream != null ? Math.round(avgStream * 1000) : null,
        totalStreamSec: Number(totalStreamSec.toFixed(1)),
        totalLatencyAvgMs: avgTotalLat != null ? Math.round(avgTotalLat * 1000) : null,
        tpsLast: lastTps,
        tpsAvg: avgTps != null ? Number(avgTps.toFixed(1)) : null,
        tpsPeak: peakTps != null ? Number(peakTps.toFixed(1)) : null,
      },
      activity: {
        userTurns,
        plannerSteps,
        errorSteps,
        runningSteps,
        retries,
        durationSec,
        thinkingRatio: output > 0 ? Number(((thinking / output) * 100).toFixed(1)) : 0,
        avgTokensPerCall: calls > 0 ? Math.round(totalTokens / calls) : 0,
      },
      models,
      modelDetails,
      toolBreakdown,
      recentCalls: recentCalls.slice(-12).reverse(),
    };
  } catch (err) {
    return {
      success: false,
      error: err.message,
    };
  }
};

app.api('/api/conversation', handleConversation, 'GET');
app.api('/api/conversation', handleConversation, 'POST');

async function buildGlobalStatsResponse() {
  const statsCandidates = [
    join(WORKSPACE_DIR, 'stats.json'),
    join(homedir(), '.gemini', 'antigravity', 'stats.json'),
  ];

  const modelMap = await getModelLabelMap();

  for (const p of statsCandidates) {
    if (!existsSync(p)) continue;
    try {
      const stats = JSON.parse(readFileSync(p, 'utf8'));
      const byDay = stats.requests_by_day || {};
      const sortedDays = Object.keys(byDay).sort();
      const recentDays30 = sortedDays.slice(-30).map((d) => ({ date: d, count: byDay[d] }));

      const rawTools = stats.tool_calls || stats.top_tools || {};
      const topTools = Array.isArray(rawTools)
        ? rawTools.slice(0, 10)
        : Object.entries(rawTools)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 10)
            .map(([name, count]) => ({ name, count }));

      // 使用实时 modelMap 重新解析模型名称（避免旧快照显示"未识别模型"）
      const convList = Array.isArray(stats.conversations) ? stats.conversations : [];
      const resolvedByModel = {};
      if (convList.length > 0 && convList.some((c) => c.models_raw)) {
        for (const c of convList) {
          const mRaw = c.models_raw || {};
          for (const [enumKey, cnt] of Object.entries(mRaw)) {
            const label = resolveModelLabel(enumKey, null, modelMap);
            resolvedByModel[label] = (resolvedByModel[label] || 0) + Number(cnt || 0);
          }
        }
      } else {
        Object.assign(resolvedByModel, stats.requests_by_model || {});
      }

      const totals = stats.totals || {};
      const convCount = Number(totals.conversations) || 0;
      const reqCount = Number(totals.requests) || 0;
      const stepCount = Number(totals.steps) || 0;
      const toolCount = Number(totals.tool_calls) || 0;
      const activeDays = Number(totals.active_days) || 0;
      const thinkingSteps = Number(totals.thinking_steps) || 0;

      const topConversations = convList.slice(0, 10).map((c) => {
        const mEntries = Object.entries(c.models_raw || {});
        let topModel = null;
        if (mEntries.length > 0) {
          mEntries.sort((a, b) => b[1] - a[1]);
          topModel = resolveModelLabel(mEntries[0][0], null, modelMap);
        }
        return {
          id: c.id,
          title: c.title || '(untitled)',
          requests: Number(c.requests) || 0,
          steps: Number(c.steps) || 0,
          toolCalls: Number(c.tool_call_count) || 0,
          durationSec: c.duration_s ?? null,
          endedAt: c.ended_at || c.started_at || null,
          topModel,
        };
      });

      return {
        success: true,
        totals: {
          ...totals,
          avgReqsPerConv: convCount > 0 ? Number((reqCount / convCount).toFixed(1)) : 0,
          avgToolsPerConv: convCount > 0 ? Number((toolCount / convCount).toFixed(1)) : 0,
          avgReqsPerActiveDay: activeDays > 0 ? Math.round(reqCount / activeDays) : 0,
          thinkingSharePct: stepCount > 0 ? Number(((thinkingSteps / stepCount) * 100).toFixed(1)) : 0,
        },
        firstDay: stats.first_day || null,
        lastDay: stats.last_day || null,
        recentDays: recentDays30.slice(-14),
        recentDays30,
        requestsByModel: resolvedByModel,
        topTools,
        topConversations,
        generatedAt: stats.generated_at,
      };
    } catch (err) {
      console.error('Error reading stats.json:', err.message);
    }
  }

  return {
    success: false,
    error: '未找到全局 stats.json，点击右上角「全量扫描」或运行 python collect.py 生成',
  };
}

// GET /api/global-stats: 获取本地全局历史统计
app.api('/api/global-stats', buildGlobalStatsResponse, 'GET');

// POST /api/global-stats/refresh: 触发本地 collect.py 实时重扫并更新 stats.json
app.api('/api/global-stats/refresh', async () => {
  const scriptPath = join(WORKSPACE_DIR, 'collect.py');
  if (!existsSync(scriptPath)) {
    return { success: false, error: `未找到采集脚本: ${scriptPath}` };
  }
  try {
    await execFileAsync('python', [scriptPath], {
      cwd: WORKSPACE_DIR,
      timeout: 30000,
    });
    return await buildGlobalStatsResponse();
  } catch (err) {
    return {
      success: false,
      error: `执行 collect.py 失败: ${err.message}`,
    };
  }
}, 'POST');

// 启动每 15 分钟自动配额采样后台任务
function startBackgroundQuotaSampler() {
  setTimeout(() => {
    sampleQuotaWindows({ force: false }).catch(() => {});
  }, 3000).unref();
  setInterval(() => {
    sampleQuotaWindows({ force: false }).catch(() => {});
  }, SAMPLE_INTERVAL_MS).unref();
}

// 启动 Sidecar 宿主服务
startBackgroundQuotaSampler();
app.run();
