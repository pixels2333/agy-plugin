// OMP Vibe Mode MCP Server (`omp-vibe`)
// Exposes the 5 oh-my-pi Vibe worker communication tools + mode toggle:
// - vibe_spawn({ cli: "fast" | "good", prompt, name? })
// - vibe_send({ session, message })
// - vibe_wait({ sessions?, timeout? })
// - vibe_kill({ session })
// - vibe_list({})
// - vibe_mode({ action: "on" | "off" | "toggle" | "status" })

import { spawn, execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { createInterface } from 'node:readline';

const STATE_PATH = join(homedir(), '.gemini', 'antigravity', 'omp-vibe-state.json');
const BRAIN_DIR = join(homedir(), '.gemini', 'antigravity', 'brain');
const AGY_BIN = join(homedir(), 'AppData', 'Local', 'agy', 'bin', 'agy.EXE');

const FAST_MODEL = 'gemini-4-argon-medium';
const GOOD_MODEL = 'gemini-4-argon-medium';

const WORKER_DIRECTIVES = `
Worker agent: delegated tasks.
Tools: FULL access (edit_file, write_file, run_command, read_file, etc.); MUST use as needed to complete task.
MUST hyperfocus assigned task; NEVER deviate.
<directives>
- MUST finish assigned work only; return minimum useful result (touched files + line ranges, commands run, verification result); do not repeat filesystem writes.
- SHOULD edit files, run commands, create files when task requires.
- MUST be concise; NEVER filler, repetition, or raw tool transcripts.
- AVOID full-file reads unless necessary; use targeted line ranges.
- SHOULD prefer editing existing files over creating new files.
- NEVER create documentation files (*.md) unless explicitly requested.
- Windows & PowerShell Host Rule: Host OS is Windows with PowerShell (pwsh). POSIX aliases (ls, cat, rm, cp, mv, echo, curl, wget, diff, sc) are disabled. Always use native PowerShell Cmdlets (Get-ChildItem, Get-Content, Remove-Item, Copy-Item, Move-Item, Invoke-WebRequest, Set-Content).
</directives>`;

const ADJECTIVES = ['bold', 'swift', 'keen', 'calm', 'bright', 'sharp', 'nimble', 'brisk', 'steady', 'vivid'];
const NOUNS = ['badger', 'falcon', 'otter', 'lynx', 'raven', 'viper', 'fox', 'hawk', 'heron', 'wolf'];

// Active child processes keyed by worker.id
const activeProcesses = new Map();

function loadState() {
  try {
    if (existsSync(STATE_PATH)) {
      const parsed = JSON.parse(readFileSync(STATE_PATH, 'utf8'));
      return {
        lastParentId: parsed.lastParentId || 'global',
        workspacePaths: parsed.workspacePaths || [process.cwd()],
        sessions: parsed.sessions || {},
        workers: parsed.workers || {},
      };
    }
  } catch {}
  return {
    lastParentId: 'global',
    workspacePaths: [process.cwd()],
    sessions: {},
    workers: {},
  };
}

function saveState(state) {
  try {
    mkdirSync(dirname(STATE_PATH), { recursive: true });
    writeFileSync(STATE_PATH, JSON.stringify(state, null, 2), 'utf8');
  } catch {}
}

function generateWorkerName(existingIds) {
  for (let i = 0; i < 50; i++) {
    const adj = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
    const noun = NOUNS[Math.floor(Math.random() * NOUNS.length)];
    const candidate = `${adj}-${noun}`;
    if (!existingIds.has(candidate)) return candidate;
  }
  return `worker-${Date.now().toString(36).slice(-4)}`;
}

function sanitizeName(raw, existingIds) {
  if (!raw || !String(raw).trim()) return generateWorkerName(existingIds);
  const cleaned = String(raw)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-_]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  if (!cleaned) return generateWorkerName(existingIds);
  if (!existingIds.has(cleaned)) return cleaned;
  let suffix = 2;
  while (existingIds.has(`${cleaned}-${suffix}`)) suffix++;
  return `${cleaned}-${suffix}`;
}

function findWorker(state, parentId, sessionKey) {
  const key = String(sessionKey || '').trim();
  if (!key) return null;
  for (const w of Object.values(state.workers)) {
    if (w.parentId === parentId && (w.id === key || w.conversationId === key)) {
      return w;
    }
  }
  for (const w of Object.values(state.workers)) {
    if (w.id === key || w.conversationId === key) {
      return w;
    }
  }
  return null;
}

function summarizeToolCall(tc) {
  const name = tc.name || 'tool';
  const args = tc.args || tc.arguments || {};
  if (name === 'read_file' || name === 'view_file') {
    const p = args.Path || args.AbsolutePath || '';
    const base = p ? basename(p) : '';
    const range = args.StartLine ? `#L${args.StartLine}${args.EndLine ? `-L${args.EndLine}` : ''}` : '';
    return `read_file: ${base}${range}`;
  }
  if (name === 'edit_file' || name === 'write_file') {
    const p = args.Path || args.TargetFile || '';
    return `${name}: ${p ? basename(p) : ''}`;
  }
  if (name === 'run_command') {
    const summary = args.toolSummary || '';
    const cmd = (args.CommandLine || '').replace(/\s+/g, ' ').trim().slice(0, 50);
    return `run_command: ${summary ? `${summary} (${cmd})` : cmd}`;
  }
  return name;
}

function syncWorkerFromBrainTranscript(worker) {
  if (!worker.conversationId) return;
  const logDir = join(BRAIN_DIR, worker.conversationId, '.system_generated', 'logs');
  const fullPath = join(logDir, 'transcript_full.jsonl');
  const compactPath = join(logDir, 'transcript.jsonl');
  const tPath = existsSync(fullPath) ? fullPath : existsSync(compactPath) ? compactPath : null;
  if (!tPath) return;

  try {
    const raw = readFileSync(tPath, 'utf8');
    const lines = raw.split(/\r?\n/).filter((l) => l.trim());
    const trace = [];
    let currentTool = null;
    let latestResponse = '';

    for (const line of lines) {
      try {
        const st = JSON.parse(line);
        if (Array.isArray(st.tool_calls) && st.tool_calls.length > 0) {
          for (const tc of st.tool_calls) {
            const label = summarizeToolCall(tc);
            trace.push(label);
            currentTool = label;
          }
        }
        if (st.type === 'PLANNER_RESPONSE' && st.content && st.content.trim()) {
          latestResponse = st.content.trim();
          if (!st.tool_calls || st.tool_calls.length === 0) {
            currentTool = null;
          }
        }
      } catch {}
    }

    if (trace.length > 0) worker.trace = trace;
    worker.currentTool = worker.state === 'running' ? currentTool : null;
    if (latestResponse) {
      worker.lastResponse = latestResponse;
      worker.outputTail = latestResponse
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean)
        .slice(-4);
    }
  } catch {}
}

function startWorkerTurn(workerId, promptText, isInitialTurn = false) {
  const state = loadState();
  const worker = Object.values(state.workers).find((w) => w.id === workerId);
  if (!worker) return;

  const model = worker.cli === 'fast' ? FAST_MODEL : GOOD_MODEL;
  const workspaceDir = (state.workspacePaths && state.workspacePaths[0]) || process.cwd();
  const fullPrompt = isInitialTurn ? `${WORKER_DIRECTIVES}\n\n# Assigned Task\n${promptText}` : promptText;

  const args = [
    '--model',
    model,
    '--mode',
    'auto',
    '--dangerously-skip-permissions',
    '--disable-slash-commands',
    '--output-format',
    'stream-json',
    '--add-dir',
    workspaceDir,
  ];

  if (!isInitialTurn && worker.conversationId && !worker.conversationId.startsWith('vibe-')) {
    args.push('--conversation', worker.conversationId);
  }

  args.push('-p', fullPrompt);

  worker.state = 'running';
  worker.settledStatus = null;
  worker.turnStartedAt = Date.now();
  worker.turnMessage = promptText;
  worker.lastActivityAt = Date.now();
  worker.activeJobId = `${worker.id}-t${worker.turns}`;
  saveState(state);

  const child = spawn(AGY_BIN, args, {
    cwd: workspaceDir,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  activeProcesses.set(worker.id, child);

  let accumulatedText = '';
  let stderrText = '';

  const rl = createInterface({ input: child.stdout });
  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    const st = loadState();
    const w = Object.values(st.workers).find((item) => item.id === workerId);
    if (!w) return;

    w.lastActivityAt = Date.now();
    try {
      const evt = JSON.parse(trimmed);
      const cid = evt.conversationId || evt.conversation_id || evt.sessionId;
      if (cid && (!w.conversationId || w.conversationId.startsWith('vibe-'))) {
        // Re-key in state.workers by real conversationId while keeping lookup by id
        delete st.workers[w.key];
        w.conversationId = cid;
        w.key = cid;
        st.workers[cid] = w;
      }
      if (evt.toolCall || evt.tool_call) {
        const tc = evt.toolCall || evt.tool_call;
        const label = summarizeToolCall(tc);
        w.trace = w.trace || [];
        w.trace.push(label);
        w.currentTool = label;
      }
      if (typeof evt.text === 'string' || typeof evt.content === 'string' || typeof evt.delta === 'string') {
        const chunk = evt.text ?? evt.content ?? evt.delta;
        accumulatedText += chunk;
        w.lastResponse = accumulatedText.trim();
        w.outputTail = w.lastResponse
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter(Boolean)
          .slice(-4);
      }
      if (typeof evt.result === 'string' && evt.result.trim()) {
        accumulatedText = evt.result.trim();
        w.lastResponse = accumulatedText;
        w.outputTail = accumulatedText
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter(Boolean)
          .slice(-4);
      }
    } catch {
      // Plain text fallback line
      accumulatedText += (accumulatedText ? '\n' : '') + trimmed;
      w.lastResponse = accumulatedText.trim();
      w.outputTail = w.lastResponse
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean)
        .slice(-4);
    }
    syncWorkerFromBrainTranscript(w);
    saveState(st);
  });

  child.stderr.on('data', (chunk) => {
    stderrText += chunk.toString('utf8');
  });

  child.on('close', (code) => {
    activeProcesses.delete(workerId);
    const st = loadState();
    const w = Object.values(st.workers).find((item) => item.id === workerId);
    if (!w) return;

    syncWorkerFromBrainTranscript(w);
    w.currentTool = null;
    w.lastDurationMs = Math.max(0, Date.now() - (w.turnStartedAt || Date.now()));
    w.lastActivityAt = Date.now();

    if (w.killed) {
      w.state = 'dead';
      w.settledStatus = 'cancelled';
      w.queue = [];
      saveState(st);
      return;
    }

    if (code !== 0 && !w.lastResponse) {
      w.state = 'idle';
      w.settledStatus = 'failed';
      w.lastError = (stderrText || `Worker exited with code ${code}`).trim().slice(0, 500);
    } else {
      w.state = 'idle';
      w.settledStatus = 'completed';
      w.lastError = null;
    }

    // If messages were queued while the worker was mid-turn, drain them into the next turn automatically!
    if (Array.isArray(w.queue) && w.queue.length > 0) {
      const nextDirective = w.queue.join('\n\n');
      w.queue = [];
      w.turns = (w.turns || 1) + 1;
      saveState(st);
      startWorkerTurn(workerId, nextDirective, false);
      return;
    }

    saveState(st);
  });
}

function formatDuration(ms) {
  if (!ms || ms < 0) return '0.0s';
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  return `${Math.floor(s / 60)}m${Math.round(s % 60)}s`;
}

function renderTvWallText(state, parentId) {
  const allWorkers = Object.values(state.workers).filter((w) => w.parentId === parentId);
  const liveScreens = allWorkers.filter((w) => !w.killed);
  const killedIds = allWorkers.filter((w) => w.killed).map((w) => w.id);

  if (liveScreens.length === 0 && killedIds.length === 0) {
    return 'No active worker sessions. Use `vibe_spawn` to start a `fast` or `good` worker.';
  }

  const blocks = [];
  for (const w of liveScreens) {
    syncWorkerFromBrainTranscript(w);
    const live = w.state === 'running' || w.state === 'starting';
    const icon = live ? '◐' : w.state === 'idle' ? '✓' : '✕';
    const qSuffix = Array.isArray(w.queue) && w.queue.length > 0 ? `+${w.queue.length}q` : '';
    const dur = live
      ? formatDuration(Date.now() - (w.turnStartedAt || Date.now()))
      : formatDuration(w.lastDurationMs || 0);
    const header = `╭─ ${icon} [${w.cli.toUpperCase()}] ${w.id} · ${w.settledStatus || w.state} · ${w.turns}t${qSuffix} · ${dur} · ${w.model}`;
    const rows = [header];

    if (w.turnMessage) {
      const oneLinePrompt = w.turnMessage.replace(/\s+/g, ' ').trim().slice(0, 96);
      rows.push(`│ > ${oneLinePrompt}`);
    }
    const traceSlice = (w.trace || []).slice(-4);
    for (const t of traceSlice) {
      rows.push(`│ └─ ${t}`);
    }
    if (live && w.currentTool) {
      rows.push(`│ └─ ${w.currentTool} ▌`);
    }
    const outSlice = (w.outputTail || []).slice(-2);
    for (const o of outSlice) {
      rows.push(`│ ${o.slice(0, 105)}`);
    }
    const transcriptLink =
      w.conversationId && !w.conversationId.startsWith('vibe-')
        ? `conversation://${w.conversationId}`
        : `history://${w.id}`;
    rows.push(`╰─ transcript: ${transcriptLink}`);
    blocks.push(rows.join('\n'));
  }

  if (killedIds.length > 0) {
    blocks.push(`Killed: ${killedIds.join(', ')} (${killedIds.length})`);
  }

  return blocks.join('\n\n');
}

function formatSettledVibeTurn(w) {
  syncWorkerFromBrainTranscript(w);
  const trace = w.trace || [];
  const traceLines = trace.slice(-10).map((t) => `- ${t}`);
  const overflow = trace.length > 10 ? `\n- … ${trace.length - 10} earlier tool call(s) not shown` : '';
  const dur = formatDuration(w.lastDurationMs || Date.now() - (w.turnStartedAt || Date.now()));
  const transcriptLink =
    w.conversationId && !w.conversationId.startsWith('vibe-')
      ? `conversation://${w.conversationId}`
      : `history://${w.id}`;

  return `<vibe-turn session="${w.id}" cli="${w.cli}" turn="${w.turns}" status="${w.settledStatus || 'completed'}" duration="${dur}" model="${w.model}">
<activity tool-calls="${trace.length}">
${traceLines.join('\n')}${overflow}
</activity>
<response>
${w.lastResponse || '(No text output returned)'}
</response>${w.lastError ? `\n<error>${w.lastError}</error>` : ''}
Session \`${w.id}\` is idle and retains this conversation — continue it with vibe_send. Transcript: ${transcriptLink}
</vibe-turn>`;
}

// =============================================================================
// Tool Implementations
// =============================================================================

async function handleVibeMode(args) {
  const state = loadState();
  const parentId = args.conversationId || state.lastParentId || 'global';
  const session = state.sessions[parentId] || { enabled: false, updatedAt: Date.now() };
  const action = String(args.action || 'status').toLowerCase();

  if (action === 'on' || action === 'enter' || action === 'enable') {
    session.enabled = true;
    session.updatedAt = Date.now();
    state.sessions[parentId] = session;
    saveState(state);
    return `🟢 Vibe Mode ON for session \`${parentId}\`.\nDirect tools (\`edit_file\`, \`write_file\`, \`run_command\`, \`search_web\`) are now DISABLED on the main session.\nWorker communication tools (\`vibe_spawn\`, \`vibe_send\`, \`vibe_wait\`, \`vibe_kill\`, \`vibe_list\`) are now OPEN.`;
  }

  if (action === 'off' || action === 'exit' || action === 'disable') {
    session.enabled = false;
    session.updatedAt = Date.now();
    state.sessions[parentId] = session;

    for (const w of Object.values(state.workers)) {
      if (w.parentId === parentId && !w.killed) {
        killWorkerProcess(w.id);
        w.state = 'dead';
        w.killed = true;
      }
    }
    saveState(state);
    return `⚪ Vibe Mode OFF for session \`${parentId}\`. All active worker sessions terminated and normal coding tools restored.`;
  }

  if (action === 'toggle') {
    return handleVibeMode({ action: session.enabled ? 'off' : 'on', conversationId: parentId });
  }

  return `Vibe Mode is currently **${session.enabled ? 'ON (Director Mode)' : 'OFF (Normal Mode)'}** for session \`${parentId}\`.\n\n${renderTvWallText(state, parentId)}`;
}

async function handleVibeSpawn(args) {
  const cli = String(args.cli || '').toLowerCase();
  if (cli !== 'fast' && cli !== 'good') {
    throw new Error('Invalid `cli` parameter: must be "fast" or "good".');
  }
  const prompt = String(args.prompt || '').trim();
  if (!prompt) {
    throw new Error('`prompt` parameter is required and must be non-empty.');
  }

  const state = loadState();
  const parentId = state.lastParentId || 'global';

  // Ensure Vibe Mode is marked active when spawning
  state.sessions[parentId] = { enabled: true, updatedAt: Date.now() };

  const existingIds = new Set(Object.values(state.workers).map((w) => w.id));
  const workerId = sanitizeName(args.name, existingIds);
  const tempKey = `vibe-${workerId}-${Date.now()}`;
  const model = cli === 'fast' ? FAST_MODEL : GOOD_MODEL;
  const jobId = `${workerId}-t1`;

  state.workers[tempKey] = {
    key: tempKey,
    id: workerId,
    conversationId: tempKey,
    parentId,
    cli,
    role: `[${cli.toUpperCase()}] ${workerId}`,
    model,
    state: 'running',
    killed: false,
    settledStatus: null,
    turns: 1,
    queued: 0,
    queue: [],
    spawnedAt: Date.now(),
    turnStartedAt: Date.now(),
    turnMessage: prompt,
    trace: [],
    outputTail: [],
    lastResponse: '',
    lastActivityAt: Date.now(),
    activeJobId: jobId,
  };
  saveState(state);

  startWorkerTurn(workerId, prompt, true);

  const previewLine = prompt.replace(/\s+/g, ' ').slice(0, 96);
  return [
    `╭─ vibe_spawn · [${cli.toUpperCase()}] ${workerId} (${model}) · 1t`,
    `│ > ${previewLine}▌`,
    `╰─ Spawned ${cli} session \`${workerId}\` (turn job \`${jobId}\`).`,
    ``,
    `Spawned ${cli} session \`${workerId}\` (turn job \`${jobId}\`). The turn result can be collected with \`vibe_wait\` — keep directing or spawning other sessions meanwhile. Continue this one with \`vibe_send\` \`${workerId}\`.`,
  ].join('\n');
}

async function handleVibeSend(args) {
  const sessionKey = String(args.session || '').trim();
  const message = String(args.message || '').trim();
  if (!sessionKey || !message) {
    throw new Error('Both `session` and `message` parameters are required.');
  }

  const state = loadState();
  const parentId = state.lastParentId || 'global';
  const worker = findWorker(state, parentId, sessionKey);
  if (!worker) {
    throw new Error(`Unknown worker session "${sessionKey}". Call \`vibe_list\` to inspect active sessions.`);
  }
  if (worker.killed || worker.state === 'dead') {
    throw new Error(`Worker session "${worker.id}" is dead/terminated and cannot receive new messages.`);
  }

  const previewLine = message.replace(/\s+/g, ' ').slice(0, 96);

  if (worker.state === 'running' || worker.state === 'starting') {
    worker.queue = worker.queue || [];
    worker.queue.push(message);
    worker.queued = worker.queue.length;
    worker.lastActivityAt = Date.now();
    saveState(state);

    return [
      `╭─ vibe_send · [${worker.cli.toUpperCase()}] ${worker.id} · queued (+${worker.queue.length}q)`,
      `│ > ${previewLine}▌`,
      `╰─ Queued for automatic next turn on \`${worker.id}\`.`,
    ].join('\n');
  }

  worker.turns = (worker.turns || 1) + 1;
  saveState(state);
  startWorkerTurn(worker.id, message, false);

  const jobId = `${worker.id}-t${worker.turns}`;
  return [
    `╭─ vibe_send · [${worker.cli.toUpperCase()}] ${worker.id} · turn ${worker.turns}t`,
    `│ > ${previewLine}▌`,
    `╰─ Started turn \`${jobId}\` on session \`${worker.id}\`.`,
  ].join('\n');
}

async function handleVibeWait(args) {
  const timeoutSec = Math.max(1, Math.min(300, Number(args.timeout) || 30));
  const watchIds = Array.isArray(args.sessions) && args.sessions.length > 0 ? new Set(args.sessions) : null;
  const deadline = Date.now() + timeoutSec * 1000;

  while (Date.now() < deadline) {
    const state = loadState();
    const parentId = state.lastParentId || 'global';
    const candidates = Object.values(state.workers).filter((w) => {
      if (w.parentId !== parentId || w.killed) return false;
      if (watchIds && !watchIds.has(w.id) && !watchIds.has(w.conversationId)) return false;
      return true;
    });

    if (candidates.length === 0) {
      return `No matching active worker sessions to wait on.\n\n${renderTvWallText(state, parentId)}`;
    }

    const settled = candidates.filter((w) => w.state === 'idle' && w.settledStatus);
    const running = candidates.filter((w) => w.state === 'running' || w.state === 'starting');

    if (settled.length > 0 || running.length === 0) {
      const turnBlocks = settled.map((w) => formatSettledVibeTurn(w)).join('\n\n');
      return `${turnBlocks}\n\n# Live TV Wall\n\`\`\`text\n${renderTvWallText(state, parentId)}\n\`\`\``;
    }

    await new Promise((r) => setTimeout(r, 800));
  }

  const finalState = loadState();
  const parentId = finalState.lastParentId || 'global';
  return `vibe_wait timed out after ${timeoutSec}s (workers still running). Re-issue \`vibe_wait\` to keep waiting.\n\n# Live TV Wall\n\`\`\`text\n${renderTvWallText(finalState, parentId)}\n\`\`\``;
}

function killWorkerProcess(workerId) {
  const child = activeProcesses.get(workerId);
  if (child && child.pid) {
    try {
      execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore' });
    } catch {}
    activeProcesses.delete(workerId);
    return true;
  }
  return false;
}

async function handleVibeKill(args) {
  const sessionKey = String(args.session || '').trim();
  if (!sessionKey) {
    throw new Error('`session` parameter is required.');
  }
  const state = loadState();
  const parentId = state.lastParentId || 'global';
  const worker = findWorker(state, parentId, sessionKey);
  if (!worker) {
    throw new Error(`Unknown worker session "${sessionKey}".`);
  }

  const cancelledTurn = killWorkerProcess(worker.id) || worker.state === 'running';
  worker.state = 'dead';
  worker.killed = true;
  worker.settledStatus = 'cancelled';
  worker.queue = [];
  worker.queued = 0;
  worker.lastActivityAt = Date.now();
  saveState(state);

  const transcriptLink =
    worker.conversationId && !worker.conversationId.startsWith('vibe-')
      ? `conversation://${worker.conversationId}`
      : `history://${worker.id}`;

  return `Terminated worker session \`${worker.id}\` (cancelledTurn=${cancelledTurn}). Transcript remains readable at ${transcriptLink}.\n\n\`\`\`text\n${renderTvWallText(state, parentId)}\n\`\`\``;
}

async function handleVibeList() {
  const state = loadState();
  const parentId = state.lastParentId || 'global';
  return `# Vibe Worker Roster & TV Wall\n\`\`\`text\n${renderTvWallText(state, parentId)}\n\`\`\``;
}
function normalizePrewalkInto(raw) {
  const t = String(raw || '').trim().toLowerCase();
  if (!t) return 'fast';
  if (['fast', 'smol', 'flash', 'cheap', '@smol'].includes(t)) return 'fast';
  if (['good', 'pro', 'task', 'strong', '@task'].includes(t)) return 'good';
  return String(raw).trim().slice(0, 48);
}

function prewalkStatusText(state, parentId) {
  const session = state.sessions[parentId] || {};
  const pw = session.prewalk || {};
  if (pw.armed) {
    return `Prewalk ARMED for \`${normalizePrewalkInto(pw.into)}\` (session \`${parentId}\`) — todo gate ${pw.todoSeen ? 'OPEN' : 'waiting for \`manage_task\`'}; handoff fires on the first edit after todos.`;
  }
  if (pw.done) return `Prewalk handed off to \`${normalizePrewalkInto(pw.into)}\` (session \`${parentId}\`); one-shot consumed.`;
  return `Prewalk OFF (session \`${parentId}\`).`;
}

async function handleVibePrewalk(args) {
  const state = loadState();
  const parentId = args.conversationId || state.lastParentId || 'global';
  const session = state.sessions[parentId] || { enabled: false, updatedAt: Date.now() };
  const action = String(args.action || 'status').toLowerCase();
  const into = normalizePrewalkInto(args.into || (session.prewalk && session.prewalk.into) || 'fast');

  if (action === 'arm' || action === 'on' || action === 'enable' || action === 'start') {
    if (session.prewalk && session.prewalk.armed) {
      return `${prewalkStatusText(state, parentId)} Existing one-shot target preserved.`;
    }
    session.prewalk = { armed: true, into, todoSeen: false, done: false, nudgePending: true, armedAt: Date.now() };
    session.updatedAt = Date.now();
    state.sessions[parentId] = session;
    saveState(state);
    return `🟡 Prewalk ARMED for \`${into}\` (session \`${parentId}\`). Investigate, create ordered todos via \`manage_task\`, then make one representative edit — the first edit after todos hands off to implementation mode (one-shot).`;
  }

  if (action === 'restart' || action === 'redo' || action === 'again') {
    session.prewalk = { armed: true, into, todoSeen: false, done: false, nudgePending: true, armedAt: Date.now() };
    session.updatedAt = Date.now();
    state.sessions[parentId] = session;
    saveState(state);
    return `🔁 Prewalk RE-ARMED for \`${into}\` (session \`${parentId}\`).`;
  }

  if (action === 'off' || action === 'disable' || action === 'stop' || action === 'cancel') {
    session.prewalk = { armed: false, into: 'fast', todoSeen: false, done: false };
    session.prewalkNeedsTodo = false;
    session.updatedAt = Date.now();
    state.sessions[parentId] = session;
    saveState(state);
    return `⚪ Prewalk OFF (session \`${parentId}\`). Pending handoff cancelled; session model unchanged.`;
  }

  return `${prewalkStatusText(state, parentId)}\n\n${renderTvWallText(state, parentId)}`;
}


// =============================================================================
// MCP JSON-RPC 2.0 Stdio Server
// =============================================================================

const TOOLS = [
  {
    name: 'vibe_spawn',
    description:
      'Starts a persistent conversational coding-agent worker session (edit, bash/pwsh, grep, read, everything).\n\nCLI flavor by task:\n- `fast`: low-latency model (Flash); mechanical, well-specified work (renames, boilerplate, running tests, data collection).\n- `good`: strong model (Pro); hard work (design, debugging, multi-file changes, judgment calls, reviewing fast output).\n\nReturns session id immediately. Session persists after turn and remembers whole conversation; follow up with `vibe_send` and NEVER spawn a second session for the same workstream.',
    inputSchema: {
      type: 'object',
      properties: {
        cli: {
          type: 'string',
          enum: ['fast', 'good'],
          description: 'Worker tier: "fast" (low-latency Flash model) or "good" (high-intelligence Pro model).',
        },
        prompt: {
          type: 'string',
          description:
            'First session instruction. Worker starts with NO context beyond it; include files, constraints, acceptance criteria.',
        },
        name: {
          type: 'string',
          description: 'Optional session label (<= 48 chars, kebab-case); otherwise generated.',
        },
      },
      required: ['cli', 'prompt'],
    },
  },
  {
    name: 'vibe_send',
    description:
      'Send a worker session message by id from `vibe_spawn`/`vibe_list`. Session retains full conversation history; refer naturally ("now do the same for the other module"). Never re-explain prior context.',
    inputSchema: {
      type: 'object',
      properties: {
        session: {
          type: 'string',
          description: 'Worker session id (or conversationId) from vibe_spawn / vibe_list.',
        },
        message: {
          type: 'string',
          description: 'Follow-up instruction, correction, scope change, or review request.',
        },
      },
      required: ['session', 'message'],
    },
  },
  {
    name: 'vibe_wait',
    description:
      'Blocks until ONE watched session finishes its current turn or the timeout elapses — not until all finish. Re-issue to keep waiting. Returns the settled `<vibe-turn>` activity trace + worker response and the live TV Wall.',
    inputSchema: {
      type: 'object',
      properties: {
        sessions: {
          type: 'array',
          items: { type: 'string' },
          description: 'Worker session ids to watch. Omit to watch every session with a turn in flight.',
        },
        timeout: {
          type: 'number',
          description: 'Seconds to wait (default 30).',
        },
      },
    },
  },
  {
    name: 'vibe_kill',
    description:
      'Terminates worker session: aborts in-flight turn, if any, and discards session from active wall while keeping transcript readable.',
    inputSchema: {
      type: 'object',
      properties: {
        session: {
          type: 'string',
          description: 'Worker session id to terminate.',
        },
      },
      required: ['session'],
    },
  },
  {
    name: 'vibe_list',
    description:
      'Worker-session roster & TV Wall: id, CLI flavor (`fast`/`good`), state (`starting`/`running`/`idle`/`dead`), model, turn count, queued messages, and latest tool-call activity.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'vibe_mode',
    description:
      'Toggle or inspect Vibe Mode state for the current main session ("on" disables direct edit/write/command tools on the main session and unlocks vibe_spawn/vibe_send/vibe_wait/vibe_kill/vibe_list; "off" kills remaining workers and restores normal tools).',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['on', 'off', 'toggle', 'status'],
          description: 'Action to perform: "on", "off", "toggle", or "status".',
        },
      },
      required: ['action'],
    },
  },
  {
    name: 'vibe_prewalk',
    description:
      'Arm, restart, cancel, or inspect the Prewalk one-shot planning-to-implementation handoff for the current session ("arm" waits for todos via manage_task plus the first file edit, then steers fast implementation mode; "restart" re-arms after a handoff; "off" cancels; "status" reports). Same lifecycle as the /prewalk slash command.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['arm', 'restart', 'off', 'status'],
          description: 'Action to perform: "arm", "restart", "off", or "status" (default).',
        },
        into: {
          type: 'string',
          description: 'Handoff implementation tier: "fast" (default, @smol equivalent) or "good".',
        },
      },
    },
  },
];

function sendJsonRpc(msg) {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

const rlServer = createInterface({ input: process.stdin });

rlServer.on('line', async (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let req;
  try {
    req = JSON.parse(trimmed);
  } catch {
    return;
  }

  const { id, method, params } = req;

  if (method === 'initialize') {
    sendJsonRpc({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: {
          tools: {},
        },
        serverInfo: {
          name: 'omp-vibe',
          version: '1.0.0',
        },
      },
    });
    return;
  }

  if (method === 'notifications/initialized') {
    return;
  }

  if (method === 'tools/list') {
    sendJsonRpc({
      jsonrpc: '2.0',
      id,
      result: {
        tools: TOOLS,
      },
    });
    return;
  }

  if (method === 'tools/call') {
    const toolName = params?.name;
    const args = params?.arguments || {};
    try {
      let textResult = '';
      if (toolName === 'vibe_spawn') {
        textResult = await handleVibeSpawn(args);
      } else if (toolName === 'vibe_send') {
        textResult = await handleVibeSend(args);
      } else if (toolName === 'vibe_wait') {
        textResult = await handleVibeWait(args);
      } else if (toolName === 'vibe_kill') {
        textResult = await handleVibeKill(args);
      } else if (toolName === 'vibe_list') {
        textResult = await handleVibeList(args);
      } else if (toolName === 'vibe_mode') {
        textResult = await handleVibeMode(args);
      } else if (toolName === 'vibe_prewalk') {
        textResult = await handleVibePrewalk(args);
      } else {
        throw new Error(`Unknown tool: ${toolName}`);
      }

      sendJsonRpc({
        jsonrpc: '2.0',
        id,
        result: {
          content: [{ type: 'text', text: textResult }],
        },
      });
    } catch (err) {
      sendJsonRpc({
        jsonrpc: '2.0',
        id,
        result: {
          isError: true,
          content: [{ type: 'text', text: `Error: ${err.message}` }],
        },
      });
    }
    return;
  }

  if (id !== undefined) {
    sendJsonRpc({
      jsonrpc: '2.0',
      id,
      error: { code: -32601, message: `Method not found: ${method}` },
    });
  }
});
