import { createServer } from 'node:http';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const STATE_PATH = join(homedir(), '.gemini', 'antigravity', 'omp-vibe-state.json');
const DEFAULT_PORT = 51400;
const BIND_HOST = '127.0.0.1';
const BRAIN_DIR = join(homedir(), '.gemini', 'antigravity', 'brain');
const DIRECTOR_MSG_SCAN_LINES = 300;
const DIRECTOR_MSG_LIMIT = 10;
const DIRECTOR_MSG_MAXLEN = 2000;

// Director (main agent) assistant messages from brain transcript.
// Reads PLANNER_RESPONSE steps with non-empty content for the current
// conversationId. Sync, bounded, never throws — returns [] on any miss.
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
    return { messages: msgs.slice(-DIRECTOR_MSG_LIMIT).reverse(), total: msgs.length };
  } catch {
    return { messages: [], total: 0 };
  }
}

// Read state safely
function loadState() {
  try {
    if (existsSync(STATE_PATH)) {
      const raw = readFileSync(STATE_PATH, 'utf8');
      const parsed = JSON.parse(raw);
      return {
        lastParentId: parsed.lastParentId || null,
        workspacePaths: parsed.workspacePaths || [],
        sessions: parsed.sessions || {},
        workers: parsed.workers || {},
      };
    }
  } catch (err) {
    console.error('[server] Error reading state:', err.message);
  }
  return {
    lastParentId: null,
    workspacePaths: [],
    sessions: {},
    workers: {},
  };
}

// Write state safely
function saveState(state) {
  try {
    mkdirSync(dirname(STATE_PATH), { recursive: true });
    writeFileSync(STATE_PATH, JSON.stringify(state, null, 2), 'utf8');
    return true;
  } catch (err) {
    console.error('[server] Error saving state:', err.message);
    return false;
  }
}

// Format worker details for API response
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

// Build consolidated status payload
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

  // Separate active vs settled
  const activeWorkers = formattedWorkers.filter((w) => !w.killed && (w.state === 'running' || w.state === 'idle'));
  const settledWorkers = formattedWorkers.filter((w) => w.killed || w.state === 'dead');

  // Sort: active workers first, then most recently active
  activeWorkers.sort((a, b) => b.lastActivityAt - a.lastActivityAt);
  settledWorkers.sort((a, b) => b.lastActivityAt - a.lastActivityAt);

  const disabledTools = isEnabled
    ? ['edit_file', 'write_file', 'run_command', 'manage_task', 'search_web', 'generate_image']
    : [];

  const enabledTools = isEnabled
    ? [
        'read_file',
        'view_file',
        'invoke_subagent (vibe-fast / vibe-good)',
        'send_message',
        'manage_subagents',
        'schedule',
        'vibe_spawn',
        'vibe_send',
        'vibe_wait',
        'vibe_kill',
        'vibe_list',
      ]
    : [
        'edit_file',
        'write_file',
        'run_command',
        'read_file',
        'view_file',
        'invoke_subagent',
        'send_message',
        'manage_task',
        'search_web',
      ];

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

// Request body parser helper
function readJsonBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 2 * 1024 * 1024) {
        req.destroy();
        resolve({});
      }
    });
    req.on('end', () => {
      if (!body.trim()) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch {
        resolve({});
      }
    });
    req.on('error', () => resolve({}));
  });
}

// Send JSON helper with CORS
function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Cache-Control': 'no-cache, no-store, must-revalidate',
  });
  res.end(JSON.stringify(data));
}

// Send static file helper
function sendFile(res, filePath, contentType) {
  try {
    if (existsSync(filePath)) {
      const content = readFileSync(filePath);
      res.writeHead(200, {
        'Content-Type': contentType,
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
      });
      res.end(content);
      return;
    }
  } catch (err) {
    console.error(`[server] Error serving ${filePath}:`, err.message);
  }
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Not Found');
}

// Locate or generate preload.js
let preloadContent = null;
function getPreloadJs() {
  if (preloadContent) return preloadContent;
  const candidatePaths = [
    join(homedir(), '.gemini', 'config', 'node_modules', 'sidecar_sdk', 'preload.js'),
    join(homedir(), '.gemini', 'antigravity', 'lib', 'node_modules', 'sidecar_sdk', 'preload.js'),
  ];
  for (const p of candidatePaths) {
    if (existsSync(p)) {
      try {
        preloadContent = readFileSync(p, 'utf8');
        return preloadContent;
      } catch {}
    }
  }
  preloadContent = '/* Antigravity Sidecar Preload Fallback */ window.sidecar = window.sidecar || {};';
  return preloadContent;
}

// Create and configure server
function createPanelServer() {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
    const pathname = url.pathname;

    // Handle CORS preflight
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      });
      res.end();
      return;
    }

    // Health check
    if (pathname === '/api/health') {
      sendJson(res, 200, { ok: true, uptime: process.uptime(), pid: process.pid });
      return;
    }

    // GET /api/status
    if (pathname === '/api/status' && req.method === 'GET') {
      const state = loadState();
      const convId = url.searchParams.get('conversationId') || null;
      const payload = buildStatusPayload(state, convId);
      sendJson(res, 200, payload);
      return;
    }

    // POST /api/toggle
    if (pathname === '/api/toggle' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const state = loadState();
      const convId = body.conversationId || state.lastParentId || 'global';
      const session = (state.sessions && state.sessions[convId]) || {
        enabled: false,
        updatedAt: Date.now(),
        promptInjected: false,
      };

      const action = String(body.action || 'toggle').toLowerCase();
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

      // If switching OFF: terminate all active workers belonging to this parent session
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
      const payload = buildStatusPayload(state, convId);
      sendJson(res, 200, payload);
      return;
    }
    // POST /api/prewalk — arm/disarm the one-shot planning→implementation handoff
    if (pathname === '/api/prewalk' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const state = loadState();
      const convId = body.conversationId || state.lastParentId || 'global';
      const session = (state.sessions && state.sessions[convId]) || { enabled: false, updatedAt: Date.now() };
      const action = String(body.action || 'toggle').toLowerCase();
      const pw = session.prewalk && typeof session.prewalk === 'object' ? session.prewalk : {};
      const rawInto = String(body.into || pw.into || 'fast');
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
          into: body.into ? normInto : (pw.into || 'fast'),
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
      sendJson(res, 200, buildStatusPayload(state, convId));
      return;
    }

    // POST /api/kill-worker
    if (pathname === '/api/kill-worker' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const workerId = String(body.workerId || '').trim();
      const convId = body.conversationId || null;
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

      const payload = buildStatusPayload(state, convId);
      sendJson(res, 200, payload);
      return;
    }

    // Static Assets
    if (pathname === '/' || pathname === '/index.html') {
      sendFile(res, join(__dirname, 'index.html'), 'text/html; charset=utf-8');
      return;
    }

    if (pathname === '/styles.css') {
      sendFile(res, join(__dirname, 'styles.css'), 'text/css; charset=utf-8');
      return;
    }

    if (pathname === '/app.js') {
      sendFile(res, join(__dirname, 'app.js'), 'application/javascript; charset=utf-8');
      return;
    }

    if (pathname === '/preload.js') {
      res.writeHead(200, {
        'Content-Type': 'application/javascript; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
      });
      res.end(getPreloadJs());
      return;
    }

    // 404
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not Found');
  });

  return server;
}

// Find available port and start server
function startServer() {
  const preferredPort = process.env.ANTIGRAVITY_SIDECAR_WEB_PORT
    ? parseInt(process.env.ANTIGRAVITY_SIDECAR_WEB_PORT, 10)
    : DEFAULT_PORT;

  let currentTryPort = preferredPort;
  const maxAttempts = 10;
  let attempts = 0;

  function attemptListen() {
    const server = createPanelServer();

    server.once('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        attempts++;
        if (attempts < maxAttempts) {
          console.warn(`[server] Port ${currentTryPort} is in use, trying ${currentTryPort + 1}...`);
          currentTryPort++;
          attemptListen();
        } else {
          console.error(`[server] Could not bind after ${maxAttempts} attempts. Exiting.`);
          process.exit(1);
        }
      } else {
        console.error('[server] Server error:', err.message);
        process.exit(1);
      }
    });

    server.once('listening', () => {
      const address = server.address();
      const actualPort = address.port;
      console.log(`[omp-vibe-panel] Server listening at http://${BIND_HOST}:${actualPort}/`);

      // Write discoverable port metadata
      try {
        writeFileSync(join(__dirname, '.port'), String(actualPort), 'utf8');
        writeFileSync(
          join(__dirname, 'vibe-panel-port.json'),
          JSON.stringify(
            {
              port: actualPort,
              host: BIND_HOST,
              url: `http://${BIND_HOST}:${actualPort}/`,
              pid: process.pid,
              startedAt: Date.now(),
            },
            null,
            2
          ),
          'utf8'
        );
      } catch (err) {
        console.warn('[server] Warning writing port metadata:', err.message);
      }
    });

    server.listen(currentTryPort, BIND_HOST);
  }

  attemptListen();
}

startServer();
