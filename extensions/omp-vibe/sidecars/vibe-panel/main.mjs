// OMP Vibe Mode Panel Backend (Antigravity Sidecar Native)
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';

const HERE = dirname(fileURLToPath(import.meta.url));
const STATE_PATH = join(homedir(), '.gemini', 'antigravity', 'omp-vibe-state.json');
const DEFAULT_PORT = 51400;
const BRAIN_DIR = join(homedir(), '.gemini', 'antigravity', 'brain');
const DIRECTOR_MSG_SCAN_LINES = 300;
const DIRECTOR_MSG_LIMIT = 10;
const DIRECTOR_MSG_MAXLEN = 2000;

// ---------------------------------------------------------------------------
// Director (main agent) assistant messages from brain transcript
// Reads PLANNER_RESPONSE steps with non-empty content for the current
// conversationId. Sync, bounded, never throws — returns [] on any miss.
// ---------------------------------------------------------------------------
function readDirectorMessages(convId) {
  if (!convId || convId === 'global') return { messages: [], total: 0 };
  try {
    const logDir = join(BRAIN_DIR, convId, '.system_generated', 'logs');
    const fullPath = join(logDir, 'transcript_full.jsonl');
    const compactPath = join(logDir, 'transcript.jsonl');
    const tPath = existsSync(fullPath) ? fullPath : existsSync(compactPath) ? compactPath : null;
    if (!tPath) return { messages: [], total: 0 };
    const raw = readFileSync(tPath, 'utf8');
    if (!raw) return { messages: [], total: 0 };
    const lines = raw.split(/\r?\n/);
    const tail = lines.length > DIRECTOR_MSG_SCAN_LINES ? lines.slice(lines.length - DIRECTOR_MSG_SCAN_LINES) : lines;
    const msgs = [];
    for (const line of tail) {
      const s = line.trim();
      if (!s) continue;
      try {
        const st = JSON.parse(s);
        if (st.type !== 'PLANNER_RESPONSE') continue;
        const content = (st.content || '').trim();
        if (!content) continue;
        msgs.push({
          step: st.step_index ?? null,
          createdAt: st.created_at || null,
          preview: content.slice(0, DIRECTOR_MSG_MAXLEN),
          truncated: content.length > DIRECTOR_MSG_MAXLEN,
          toolCalls: Array.isArray(st.tool_calls) ? st.tool_calls.length : 0,
        });
      } catch {}
    }
    const total = msgs.length;
    const recent = msgs.slice(-DIRECTOR_MSG_LIMIT).reverse();
    return { messages: recent, total };
  } catch {
    return { messages: [], total: 0 };
  }
}

function readLocal(name) {
  try {
    return readFileSync(join(HERE, name), 'utf8');
  } catch (err) {
    return '';
  }
}

// ---------------------------------------------------------------------------
// State Management
// ---------------------------------------------------------------------------
function loadState() {
  try {
    if (existsSync(STATE_PATH)) {
      const parsed = JSON.parse(readFileSync(STATE_PATH, 'utf8'));
      return {
        lastParentId: parsed.lastParentId || null,
        workspacePaths: parsed.workspacePaths || [],
        sessions: parsed.sessions || {},
        workers: parsed.workers || {},
      };
    }
  } catch {}
  return {
    lastParentId: null,
    workspacePaths: [],
    sessions: {},
    workers: {},
  };
}

function saveState(state) {
  try {
    mkdirSync(dirname(STATE_PATH), { recursive: true });
    writeFileSync(STATE_PATH, JSON.stringify(state, null, 2), 'utf8');
    return true;
  } catch {
    return false;
  }
}

function formatWorker(w) {
  const isKilled = Boolean(w.killed || w.state === 'dead');
  const now = Date.now();
  let durationMs = w.lastDurationMs || 0;
  if (!isKilled && w.turnStartedAt) {
    durationMs = Math.max(0, now - w.turnStartedAt);
  } else if (!durationMs && w.spawnedAt) {
    durationMs = Math.max(0, (w.lastActivityAt || now) - w.spawnedAt);
  }

  return {
    id: w.id || w.conversationId || 'unknown-worker',
    key: w.key || w.id,
    conversationId: w.conversationId || w.id,
    parentId: w.parentId || null,
    cli: w.cli || 'fast',
    role: w.role || (w.cli === 'good' ? '[GOOD] 专家工作机' : '[FAST] 机械工作机'),
    model: w.model || (w.cli === 'good' ? 'pro' : 'flash'),
    state: isKilled ? 'dead' : (w.state || 'idle'),
    killed: isKilled,
    settledStatus: w.settledStatus || (isKilled ? 'cancelled' : 'running'),
    turns: w.turns || 1,
    spawnedAt: w.spawnedAt || now,
    turnStartedAt: w.turnStartedAt || null,
    lastActivityAt: w.lastActivityAt || now,
    durationMs,
    currentTool: isKilled ? null : (w.currentTool || null),
    trace: Array.isArray(w.trace) ? w.trace : [],
    outputTail: Array.isArray(w.outputTail) ? w.outputTail : [],
    lastResponse: (w.lastResponse || '').slice(0, 1000),
    turnMessage: (w.turnMessage || '').slice(0, 500),
  };
}

function buildStatusPayload(state, queryConvId) {
  const convId = queryConvId || state.lastParentId || Object.keys(state.sessions || {})[0] || 'global';
  const session = (state.sessions && state.sessions[convId]) || {
    enabled: false,
    updatedAt: Date.now(),
    promptInjected: false,
  };
  const isEnabled = Boolean(session.enabled);

  const rawWorkers = Object.values(state.workers || {});
  const formattedWorkers = rawWorkers.map(formatWorker);
  const activeWorkers = formattedWorkers.filter((w) => !w.killed && (w.state === 'running' || w.state === 'idle'));
  const settledWorkers = formattedWorkers.filter((w) => w.killed || w.state === 'dead');

  activeWorkers.sort((a, b) => b.lastActivityAt - a.lastActivityAt);
  settledWorkers.sort((a, b) => b.lastActivityAt - a.lastActivityAt);

  const disabledTools = isEnabled
    ? ['edit_file', 'write_file', 'run_command', 'manage_task', 'search_web', 'generate_image']
    : [];

  const enabledTools = isEnabled
    ? ['read_file', 'view_file', 'invoke_subagent (vibe-fast / vibe-good)', 'send_message', 'manage_subagents', 'schedule', 'vibe_*']
    : ['edit_file', 'write_file', 'run_command', 'read_file', 'view_file', 'invoke_subagent', 'send_message', 'manage_task', 'search_web'];

  const director = readDirectorMessages(convId);

  const _pw = session.prewalk && typeof session.prewalk === 'object' ? session.prewalk : {};
  const prewalk = {
    armed: Boolean(_pw.armed),
    into: String(_pw.into || 'fast'),
    todoSeen: Boolean(_pw.todoSeen),
    done: Boolean(_pw.done),
  };
  return {
    ok: true,
    enabled: isEnabled,
    conversationId: convId,
    lastParentId: state.lastParentId,
    session: {
      enabled: isEnabled,
      updatedAt: session.updatedAt || Date.now(),
      promptInjected: Boolean(session.promptInjected),
      prewalk,
    },
    sessions: state.sessions || {},
    workspacePaths: state.workspacePaths || [],
    activeCount: activeWorkers.length,
    settledCount: settledWorkers.length,
    activeWorkers,
    settledWorkers,
    allWorkers: formattedWorkers,
    disabledTools,
    enabledTools,
    directorConversationId: convId,
    directorMessages: director.messages,
    directorTotal: director.total,
    timestamp: Date.now(),
    prewalk,
  };
}

function handleToggle(data) {
  const state = loadState();
  const convId = data.conversationId || state.lastParentId || 'global';
  const session = (state.sessions && state.sessions[convId]) || {
    enabled: false,
    updatedAt: Date.now(),
    promptInjected: false,
  };

  const action = String(data.action || 'toggle').toLowerCase();
  let newEnabled = session.enabled;
  if (action === 'toggle') {
    newEnabled = !session.enabled;
  } else if (action === 'on' || action === 'enable' || action === 'start') {
    newEnabled = true;
  } else if (action === 'off' || action === 'disable' || action === 'stop') {
    newEnabled = false;
  }

  session.enabled = newEnabled;
  session.updatedAt = Date.now();
  if (!newEnabled) {
    session.promptInjected = false;
  }
  state.sessions[convId] = session;

  if (!newEnabled) {
    for (const w of Object.values(state.workers || {})) {
      if ((w.parentId === convId || convId === 'global') && !w.killed) {
        w.state = 'dead';
        w.killed = true;
        w.killedReason = 'panel-toggle-off';
        w.settledStatus = 'cancelled';
        w.lastActivityAt = Date.now();
      }
    }
  }

  saveState(state);
  return buildStatusPayload(state, convId);
}

function handleKillWorker(data) {
  const workerId = String(data.workerId || '').trim();
  const convId = data.conversationId || null;
  const state = loadState();

  let targetWorker = null;
  for (const w of Object.values(state.workers || {})) {
    if (w.id === workerId || w.key === workerId || w.conversationId === workerId) {
      targetWorker = w;
      break;
    }
  }

  if (targetWorker) {
    targetWorker.state = 'dead';
    targetWorker.killed = true;
    targetWorker.killedReason = 'panel-kill-worker';
    targetWorker.settledStatus = 'cancelled';
    targetWorker.lastActivityAt = Date.now();
    saveState(state);
  }

  return buildStatusPayload(state, convId);
}
function handlePrewalkPanel(data) {
  const state = loadState();
  const convId = data.conversationId || state.lastParentId || 'global';
  const session = (state.sessions && state.sessions[convId]) || { enabled: false, updatedAt: Date.now() };
  const action = String(data.action || 'toggle').toLowerCase();
  const pw = session.prewalk && typeof session.prewalk === 'object' ? session.prewalk : {};
  const rawInto = String(data.into || pw.into || 'fast');
  const low = rawInto.trim().toLowerCase();
  const normInto = ['fast', 'smol', 'flash', 'cheap', '@smol'].includes(low)
    ? 'fast'
    : (['good', 'pro', 'task', 'strong', '@task'].includes(low) ? 'good' : rawInto.trim().slice(0, 48) || 'fast');
  if (action === 'off' || action === 'disable' || action === 'stop' || action === 'cancel' || (action === 'toggle' && pw.armed)) {
    session.prewalk = { armed: false, into: 'fast', todoSeen: false, done: false };
    session.prewalkNeedsTodo = false;
  } else {
    session.prewalk = {
      armed: true,
      into: data.into ? normInto : (pw.into || 'fast'),
      todoSeen: false,
      done: false,
      nudgePending: true,
      armedAt: Date.now(),
    };
    session.prewalkNeedsTodo = false;
  }
  session.updatedAt = Date.now();
  state.sessions[convId] = session;
  saveState(state);
  return buildStatusPayload(state, convId);
}

// ---------------------------------------------------------------------------
// Run via sidecar_sdk if available in Antigravity supervisor
// ---------------------------------------------------------------------------
let isSidecarSdk = false;
try {
  const { Response, SidecarApp } = await import('sidecar_sdk');
  if (process.env.ANTIGRAVITY_LS_ADDRESS && process.env.ANTIGRAVITY_SIDECAR_WEB_PORT) {
    isSidecarSdk = true;
    const app = new SidecarApp();

    app.page('/', () => new Response(readLocal('index.html'), { contentType: 'text/html', headers: { 'Cache-Control': 'no-cache' } }));
    app.page('/index.html', () => new Response(readLocal('index.html'), { contentType: 'text/html', headers: { 'Cache-Control': 'no-cache' } }));
    app.page('/app.js', () => new Response(readLocal('app.js'), { contentType: 'application/javascript', headers: { 'Cache-Control': 'no-cache' } }));
    app.api('/styles.css', () => new Response(readLocal('styles.css'), { contentType: 'text/css', headers: { 'Cache-Control': 'no-cache' } }), 'GET');

    app.api('/api/status', (data) => buildStatusPayload(loadState(), data?.conversationId), 'GET');
    app.api('/api/toggle', (data) => handleToggle(data || {}), 'POST');
    app.api('/api/prewalk', (data) => handlePrewalkPanel(data || {}), 'POST');
    app.api('/api/kill-worker', (data) => handleKillWorker(data || {}), 'POST');

    app.run();
    console.log('[omp-vibe-panel] SidecarApp running inside Antigravity Supervisor.');
  }
} catch (err) {
  // Not in supervisor or sidecar_sdk not found
}

// ---------------------------------------------------------------------------
// Standalone HTTP Server Fallback (when run independently or port 51400)
// ---------------------------------------------------------------------------
if (!isSidecarSdk) {
  const port = process.env.ANTIGRAVITY_SIDECAR_WEB_PORT
    ? parseInt(process.env.ANTIGRAVITY_SIDECAR_WEB_PORT, 10)
    : DEFAULT_PORT;

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
    const pathname = url.pathname;

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    if (pathname === '/' || pathname === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(readLocal('index.html'));
      return;
    }

    if (pathname === '/styles.css') {
      res.writeHead(200, { 'Content-Type': 'text/css; charset=utf-8' });
      res.end(readLocal('styles.css'));
      return;
    }

    if (pathname === '/app.js') {
      res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' });
      res.end(readLocal('app.js'));
      return;
    }

    if (pathname === '/api/status' && req.method === 'GET') {
      const convId = url.searchParams.get('conversationId') || null;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(buildStatusPayload(loadState(), convId)));
      return;
    }

    if (pathname === '/api/toggle' && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        let parsed = {};
        try { parsed = JSON.parse(body); } catch {}
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(handleToggle(parsed)));
      });
      return;
    }
    if (pathname === '/api/prewalk' && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        let parsed = {};
        try { parsed = JSON.parse(body); } catch {}
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(handlePrewalkPanel(parsed)));
      });
      return;
    }

    if (pathname === '/api/kill-worker' && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        let parsed = {};
        try { parsed = JSON.parse(body); } catch {}
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(handleKillWorker(parsed)));
      });
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  });

  server.listen(port, '127.0.0.1', () => {
    console.log(`[omp-vibe-panel] Standalone server listening at http://127.0.0.1:${port}/`);
  });
}
