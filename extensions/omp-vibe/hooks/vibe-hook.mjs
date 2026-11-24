// OMP Vibe Mode + Prewalk Lifecycle Hook:
// 1. PreInvocation:
//    - Supports `/vibe`, `/vibe on`, `/vibe off`, `/vibe status`, `/vibe <prompt>`,
//      as well as `/vibe-on` and `/vibe-off` slash commands.
//    - Supports `/prewalk [fast|good|<model>]`, `/prewalk restart [from] [into]`,
//      `/prewalk off`, `/prewalk status` (one-shot planning -> implementation handoff).
//    - For pure mode switches (`/vibe`, `/vibe on`, `/vibe off`, `/vibe-on`, `/vibe-off`,
//      `/vibe status`, `/prewalk`, `/prewalk off`, `/prewalk status`),
//      uses `"terminationBehavior": "terminate"` + `metadata.user_markdown` so the mode switches
//      INSTANTLY in the chat UI without consuming an LLM turn!
//    - For `/vibe <prompt>` (or `/vibe on <prompt>`), enables Vibe Mode, injects `<vibe-mode>`,
//      and proceeds to the LLM to execute `<prompt>` as Director.
// 2. PreToolUse:
//    - When Vibe Mode is ON: hard-blocks (`decision: "deny"`) direct execution tools
//      (`edit_file`, `write_file`, `run_command`, `manage_task`, `search_web`, `generate_image`)
//      on the main session, while allowing `read_file` and Worker communication tools.
//    - Prewalk (Vibe OFF): tracks the todo gate (`manage_task`) + first `edit_file`/`write_file`
//      to fire the one-shot handoff to implementation mode. Never blocks; only observes.
//    - When Vibe Mode is OFF: allows all normal coding tools and blocks `vibe_*` worker tools
//      (except `vibe_mode` / `vibe_prewalk` control tools).

import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const STATE_PATH = join(homedir(), '.gemini', 'antigravity', 'omp-vibe-state.json');

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
  } catch {}
}

async function readStdinJson() {
  try {
    const chunks = [];
    for await (const chunk of process.stdin) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    }
    const raw = Buffer.concat(chunks).toString('utf8');
    if (!raw || !raw.trim()) return {};
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function extractCleanUserInput(rawInput) {
  const s = String(rawInput || '').trim();
  if (!s) return '';
  // If wrapped in <USER_REQUEST>...</USER_REQUEST>, extract inner text
  const m = s.match(/<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/i);
  const body = (m ? m[1] : s).trim();
  return body;
}

const DIRECTOR_SYSTEM_PROMPT = `<vibe-mode>
Vibe mode ON. You are DIRECTOR: drive two worker CLIs (\`fast\` and \`good\`), full coding agents with every normal tool; NEVER edit, run, grep, or build yourself. Verify work by reading files (\`read_file\`).

Active Toolset in Vibe Mode:
- \`read_file\` (ONLY way to inspect files and verify worker claims)
- Native Subagent Worker tools (\`invoke_subagent\` with \`vibe-fast\` / \`vibe-good\`, \`send_message\`, \`manage_subagents\`, \`schedule\`) OR \`omp-vibe\` MCP tools (\`vibe_spawn\`, \`vibe_send\`, \`vibe_wait\`, \`vibe_kill\`, \`vibe_list\`)

All direct execution tools (\`edit_file\`, \`write_file\`, \`run_command\`, \`manage_task\`, \`search_web\`) are HARD-DISABLED by PreToolUse hook while Vibe Mode is ON.

# Subagent Naming and Tier Standards (CRITICAL)

When invoking subagents (\`invoke_subagent\`):
- **Role (上面的名字 / 面板顶部标题)**: 必须严格使用清晰具体的【中文】角色名（例如：\`古明地恋字节码反编译器与重构器\`、\`符卡逻辑移植员\`、\`资产比对审计员\`、\`自动化测试执行员\`），严禁使用英文！这决定了 Antigravity 子代理面板顶部的显示标题。
- **TypeName (下面的类型标签 / 输入框徽章)**: 必须严格且仅指定为 \`vibe-fast\` 或 \`vibe-good\`，严禁使用 \`vibe-worker\`、\`self\` 或任何其他临时名称！这决定了输入框下方徽章显示的子代理类型。

# Workers

- \`fast\` (\`vibe-fast\`, \`Model: "flash"\`): low-latency model; mechanical, well-specified work — renames, small fixes, boilerplate, data collection, tests and output reports.
- \`good\` (\`vibe-good\`, \`Model: "pro"\`): strong model; design, tricky debugging, multi-file refactors, judgment-heavy work, reviewing \`fast\` output.

Sessions: persistent worker conversations; remember instructions and work. One session per workstream; keep it on that workstream. Spawn once, then use the SAME session for follow-ups; NEVER respawn it.

# Direction

1. Split requests into independent workstreams.
2. Spawn each with \`TypeName: "vibe-fast"\` or \`"vibe-good"\`, a **Chinese** \`Role\`, and a complete self-contained brief: files, constraints, acceptance criteria. Workers start blank; never see this conversation.
3. Sends/spawns return immediately; results arrive when a worker finishes its turn. Direct other sessions meanwhile; wait only when unable to proceed without a result.
4. On each result, \`read_file\` touched files to verify claims before building on them; send corrections, next step, or review request.
5. Route by difficulty: draft with \`fast\`; escalate to \`good\` if \`fast\` stalls or judgment is needed. \`good\` designs; \`fast\` executes mechanical parts.
6. Kill stuck sessions or sessions whose workstream is done; list if roster lost.

Run sessions concurrently — normally one \`fast\` and one \`good\` on different workstreams. Final outcome yours: verify with \`read_file\`; do not take a worker's word for it.
</vibe-mode>`;
// Prewalk: one-shot handoff from the planning model to a faster/cheaper implementation
// tier inside the SAME normal session (mirrors omp `prewalk`: strong plans, fast implements).
// Armed via `/prewalk`, fires on todo gate (`manage_task`) + first `edit_file`/`write_file`.
// One-shot: after the handoff it disarms itself and steers with an implementation checklist.
// While Vibe Mode is ON, direct edits are denied so a pending prewalk simply waits.
const PREWALK_DEFAULT_INTO = 'fast';
function normalizePrewalkInto(raw) {
  const t = String(raw || '').trim().toLowerCase();
  if (!t) return PREWALK_DEFAULT_INTO;
  if (['fast', 'smol', 'flash', 'cheap', '@smol'].includes(t)) return 'fast';
  if (['good', 'pro', 'task', 'strong', '@task'].includes(t)) return 'good';
  return String(raw).trim().slice(0, 48);
}
function getPrewalk(session) {
  const pw = (session && session.prewalk) || {};
  return {
    armed: Boolean(pw.armed),
    into: normalizePrewalkInto(pw.into || PREWALK_DEFAULT_INTO),
    todoSeen: Boolean(pw.todoSeen),
    done: Boolean(pw.done),
    justSwitched: Boolean(pw.justSwitched),
    nudgePending: Boolean(pw.nudgePending),
  };
}
function prewalkStatusLine(session) {
  const pw = getPrewalk(session);
  if (pw.armed) {
    return pw.todoSeen
      ? `🟡 **Prewalk ARMED for \`${pw.into}\`** — todo gate open, waiting for the first edit to hand off.`
      : `🟡 **Prewalk ARMED for \`${pw.into}\`** — waiting for todos (\`manage_task\`) + first edit to hand off.`;
  }
  if (pw.done) return `✅ **Prewalk handed off to \`${pw.into}\`** (one-shot consumed). Run \`/prewalk restart\` to arm again.`;
  return '⚪ **Prewalk OFF** — run `/prewalk` to arm a planning → implementation handoff.';
}
const PREWALK_PLAN_NUDGE = (into) => `<prewalk-plan>Prewalk armed for \`${into}\`: investigate with reads, create a specific ordered todo list via \`manage_task\`, then begin with one representative edit. The first edit after todos hands off this same session to implementation mode (one-shot, no model switch on this host — continue in fast, mechanical execution style).</prewalk-plan>`;
const PREWALK_SWITCH_PROMPT = (into) => `<prewalk-switched>Prewalk handoff complete: planning produced the todo list and the first edit; you now continue as the implementation tier (\`${into}\`).
1. Follow the existing todos in order; keep them updated via \`manage_task\`.
2. Implement the remaining work mechanically; do not re-plan the approach unless implementation reveals a bad assumption.
3. Adapt when reality differs, test the result, and finish cleanup.
4. Read back touched files before reporting done.</prewalk-switched>`;
function parsePrewalkCommand(cleanInput) {
  const m = String(cleanInput || '').match(/^\/prewalk(?:\s+([\s\S]*))?$/i);
  if (!m) return { matched: false };
  const rest = (m[1] || '').trim();
  if (!rest) return { matched: true, action: 'arm', into: null };
  const parts = rest.split(/\s+/);
  const first = parts[0].toLowerCase();
  if (['off', 'disable', 'stop', 'cancel'].includes(first)) return { matched: true, action: 'off' };
  if (['status', 'state', 'show'].includes(first)) return { matched: true, action: 'status' };
  if (['restart', 'redo', 'again'].includes(first)) {
    const intoTok = parts.slice(1).find((p) => !/^from$/i.test(p) && !/^into$/i.test(p));
    return { matched: true, action: 'restart', into: intoTok || null };
  }
  if (['on', 'arm', 'enable', 'start'].includes(first)) {
    const intoTok = parts.slice(1).find((p) => !/^into$/i.test(p));
    return { matched: true, action: 'arm', into: intoTok || null };
  }
  const intoTok = parts.find((p) => !/^into$/i.test(p));
  return { matched: true, action: 'arm', into: intoTok || null };
}

function parseVibeCommand(cleanInput) {
  // Match:
  // - `/vibe-on [prompt]`
  // - `/vibe-off`
  // - `/vibe [on|off|exit|disable|enable|status] [prompt]`
  // - `/vibe <prompt>`
  const onSlash = cleanInput.match(/^\/vibe-on(?:\s+([\s\S]*))?$/i);
  if (onSlash) {
    const rest = (onSlash[1] || '').trim();
    return { matched: true, action: 'on', prompt: rest };
  }

  const offSlash = cleanInput.match(/^\/vibe-off(?:\s+([\s\S]*))?$/i);
  if (offSlash) {
    return { matched: true, action: 'off', prompt: '' };
  }

  const mainSlash = cleanInput.match(/^\/vibe(?:\s+([\s\S]*))?$/i);
  if (!mainSlash) return { matched: false };

  const rawArg = (mainSlash[1] || '').trim();
  if (!rawArg) {
    return { matched: true, action: 'toggle', prompt: '' };
  }

  const firstWordMatch = rawArg.match(/^(\S+)(?:\s+([\s\S]*))?$/);
  const firstWord = (firstWordMatch ? firstWordMatch[1] : rawArg).toLowerCase();
  const restPrompt = (firstWordMatch && firstWordMatch[2] ? firstWordMatch[2] : '').trim();

  if (firstWord === 'on' || firstWord === 'enable' || firstWord === 'start') {
    return { matched: true, action: 'on', prompt: restPrompt };
  }
  if (firstWord === 'off' || firstWord === 'exit' || firstWord === 'disable' || firstWord === 'stop') {
    return { matched: true, action: 'off', prompt: '' };
  }
  if (firstWord === 'status') {
    return { matched: true, action: 'status', prompt: '' };
  }

  // Otherwise `/vibe <task prompt>` -> turn ON and run prompt
  return { matched: true, action: 'on', prompt: rawArg };
}

function handlePreInvocation(input) {
  const convId = input.conversationId;
  if (!convId) {
    process.stdout.write(JSON.stringify({}));
    return;
  }

  const state = loadState();

  // If this conversation is a spawned child worker, never apply Director mode hooks to it
  if (state.workers && state.workers[convId]) {
    process.stdout.write(JSON.stringify({}));
    return;
  }

  state.lastParentId = convId;
  if (Array.isArray(input.workspacePaths) && input.workspacePaths.length > 0) {
    state.workspacePaths = input.workspacePaths;
  }

  const session = state.sessions[convId] || { enabled: false, updatedAt: Date.now() };
  const cleanInput = extractCleanUserInput(input.lastUserInput);
  const parsedCmd = parseVibeCommand(cleanInput);
  // Prewalk commands (`/prewalk ...`) — independent of Vibe Mode, instant switch, no LLM turn.
  const parsedPrewalk = parsePrewalkCommand(cleanInput);
  if (parsedPrewalk.matched) {
    if (parsedPrewalk.action === 'status') {
      state.sessions[convId] = session;
      saveState(state);
      process.stdout.write(
        JSON.stringify({
          injectSteps: [
            { systemMessage: { systemMessage: '', metadata: { user_markdown: prewalkStatusLine(session) } } },
          ],
          terminationBehavior: 'terminate',
        })
      );
      return;
    }
    if (parsedPrewalk.action === 'off') {
      session.prewalk = { armed: false, into: PREWALK_DEFAULT_INTO, todoSeen: false, done: false };
      session.prewalkNeedsTodo = false;
      session.updatedAt = Date.now();
      state.sessions[convId] = session;
      saveState(state);
      process.stdout.write(
        JSON.stringify({
          injectSteps: [
            { systemMessage: { systemMessage: '', metadata: { user_markdown: '⚪ **Prewalk OFF** — pending handoff cancelled; session model unchanged.' } } },
          ],
          terminationBehavior: 'terminate',
        })
      );
      return;
    }
    if (parsedPrewalk.action === 'restart') {
      const into = normalizePrewalkInto(parsedPrewalk.into || getPrewalk(session).into);
      session.prewalk = { armed: true, into, todoSeen: false, done: false, nudgePending: true, armedAt: Date.now() };
      session.prewalkNeedsTodo = false;
      session.updatedAt = Date.now();
      state.sessions[convId] = session;
      saveState(state);
      process.stdout.write(
        JSON.stringify({
          injectSteps: [
            { systemMessage: { systemMessage: '', metadata: { user_markdown: `🔁 **Prewalk RE-ARMED for \`${into}\`** — plan from the current model, then hand off on todos + first edit.` } } },
          ],
          terminationBehavior: 'terminate',
        })
      );
      return;
    }
    // arm (bare `/prewalk` or `/prewalk <target>`): keep the existing target if already armed.
    const existing = getPrewalk(session);
    const into = existing.armed ? existing.into : normalizePrewalkInto(parsedPrewalk.into);
    if (existing.armed) {
      state.sessions[convId] = session;
      saveState(state);
      process.stdout.write(
        JSON.stringify({
          injectSteps: [
            { systemMessage: { systemMessage: '', metadata: { user_markdown: `🟡 **Prewalk already armed for \`${into}\`** — existing one-shot target preserved. ${prewalkStatusLine(session)}` } } },
          ],
          terminationBehavior: 'terminate',
        })
      );
      return;
    }
    session.prewalk = { armed: true, into, todoSeen: false, done: false, nudgePending: true, armedAt: Date.now() };
    session.prewalkNeedsTodo = false;
    session.updatedAt = Date.now();
    state.sessions[convId] = session;
    saveState(state);
    process.stdout.write(
      JSON.stringify({
        injectSteps: [
          { systemMessage: { systemMessage: '', metadata: { user_markdown: `🟡 **Prewalk ARMED for \`${into}\`** — omp is waiting for the todo list (\`manage_task\`) and the first edit. Read-only investigation does not consume the handoff.` } } },
        ],
        terminationBehavior: 'terminate',
      })
    );
    return;
  }

  if (parsedCmd.matched) {
    let targetAction = parsedCmd.action;
    if (targetAction === 'toggle') {
      targetAction = session.enabled ? 'off' : 'on';
    }

    if (targetAction === 'status') {
      saveState(state);
      // Pure status query -> terminate immediately (agent never invoked)
      process.stdout.write(
        JSON.stringify({
          injectSteps: [],
          terminationBehavior: 'terminate',
        })
      );
      return;
    }

    if (targetAction === 'off') {
      session.enabled = false;
      session.promptInjected = false;
      session.updatedAt = Date.now();
      state.sessions[convId] = session;

      // Mark any active workers of this parent session as killed on mode exit
      for (const w of Object.values(state.workers)) {
        if (w.parentId === convId && !w.killed) {
          w.state = 'dead';
          w.killed = true;
          w.killedReason = 'mode-exit';
        }
      }
      saveState(state);

      // Pure mode switch -> terminate immediately: 0ms, no agent invocation, no SKILL.md reading, no Error badge!
      process.stdout.write(
        JSON.stringify({
          injectSteps: [],
          terminationBehavior: 'terminate',
        })
      );
      return;
    }

    if (targetAction === 'on') {
      const hasPrompt = Boolean(parsedCmd.prompt && parsedCmd.prompt.trim().length > 0);
      session.enabled = true;
      session.promptInjected = hasPrompt;
      session.updatedAt = Date.now();
      state.sessions[convId] = session;
      saveState(state);

      // Pure `/vibe-on` or `/vibe on` (no task prompt) -> instant mode switch, agent NOT invoked!
      if (!hasPrompt) {
        process.stdout.write(
          JSON.stringify({
            injectSteps: [],
            terminationBehavior: 'terminate',
          })
        );
        return;
      }

      // `/vibe <task>` or `/vibe on <task>` -> switch ON and proceed directly to the LLM call to work on <task>
      const promptSuffix = `\n\nFirst Director Objective from user:\n${parsedCmd.prompt}`;
      process.stdout.write(
        JSON.stringify({
          injectSteps: [
            {
              systemMessage: {
                systemMessage: `${DIRECTOR_SYSTEM_PROMPT}${promptSuffix}`,
                metadata: {
                  user_markdown:
                    '🟢 **OMP Vibe Mode: ON (Director Active)** — 已禁用主会话直接执行工具（`edit_file` / `write_file` / `run_command` / `search_web`），已开放 Worker 通信工具集，开始编排任务。',
                },
              },
            },
          ],
          terminationBehavior: '',
        })
      );
      return;
    }
  }

  if (session.enabled) {
    const activeWorkers = Object.values(state.workers)
      .filter((w) => w.parentId === convId && !w.killed)
      .map((w) => `${w.id} [${w.cli}/${w.state}]`);
    const rosterNote =
      activeWorkers.length > 0
        ? `Active workers: ${activeWorkers.join(', ')}.`
        : 'No active workers spawned yet.';

    const steps = [];
    if (!session.promptInjected) {
      session.promptInjected = true;
      steps.push({
        systemMessage: {
          systemMessage: DIRECTOR_SYSTEM_PROMPT,
          metadata: {
            user_markdown:
              '🟢 **OMP Vibe Mode (Director Active)** — 当前会话处于 Director 编排模式（主会话仅保留 `read_file` 与 Worker 通信工具集）。',
          },
        },
      });
    }
    saveState(state);

    steps.push({
      ephemeralMessage: `<vibe-mode-reminder>Vibe Mode is ON. You are the DIRECTOR. Direct edit/write/command tools are disabled by PreToolUse hook. Use ONLY \`read_file\` and Worker communication tools (\`invoke_subagent\` with \`vibe-fast\`/\`vibe-good\`, \`send_message\`, \`manage_subagents\`, or \`vibe_spawn\`/\`vibe_send\`/\`vibe_wait\`/\`vibe_kill\`/\`vibe_list\`). ${rosterNote}</vibe-mode-reminder>`,
    });

    process.stdout.write(
      JSON.stringify({
        injectSteps: steps,
      })
    );
    return;
  }
  // Prewalk steady-state (normal sessions only; the Vibe block above already returned).
  // - justSwitched: deliver the implementation checklist once, then proceed to the LLM.
  // - nudgePending: deliver the planning nudge with the task's first request.
  // - prewalkNeedsTodo: remind once that todos must come before the first edit.
  {
    const pw = getPrewalk(session);
    if (pw.justSwitched) {
      session.prewalk.justSwitched = false;
      session.prewalk.done = true;
      state.sessions[convId] = session;
      saveState(state);
      process.stdout.write(
        JSON.stringify({
          injectSteps: [
            {
              systemMessage: {
                systemMessage: PREWALK_SWITCH_PROMPT(pw.into),
                metadata: {
                  user_markdown: `🔀 **Prewalk SWITCHED to \`${pw.into}\`** — planning edit landed; continuing in fast implementation mode.`,
                },
              },
            },
          ],
          terminationBehavior: '',
        })
      );
      return;
    }
    if (pw.armed && pw.nudgePending) {
      session.prewalk.nudgePending = false;
      state.sessions[convId] = session;
      saveState(state);
      process.stdout.write(
        JSON.stringify({
          injectSteps: [{ systemMessage: { systemMessage: PREWALK_PLAN_NUDGE(pw.into) } }],
          terminationBehavior: '',
        })
      );
      return;
    }
    if (pw.armed && session.prewalkNeedsTodo) {
      session.prewalkNeedsTodo = false;
      state.sessions[convId] = session;
      saveState(state);
      process.stdout.write(
        JSON.stringify({
          injectSteps: [
            { ephemeralMessage: '<prewalk-reminder>Prewalk is armed but no todos exist yet — create the ordered todo list via `manage_task` first; the handoff fires on the first edit AFTER todos.</prewalk-reminder>' },
          ],
        })
      );
      return;
    }
  }

  saveState(state);

  process.stdout.write(JSON.stringify({}));
}

function resolveVibeMcpToolName(toolName, args) {
  const lower = String(toolName || '').toLowerCase();
  const matchDirect = lower.match(/vibe_(spawn|send|wait|kill|list|mode|prewalk)$/);
  if (matchDirect) return `vibe_${matchDirect[1]}`;

  if (lower === 'call_mcp_tool' && args) {
    const server = String(args.ServerName || args.serverName || '').toLowerCase();
    const innerTool = String(args.ToolName || args.toolName || '').toLowerCase();
    if (server.includes('omp-vibe') && /^vibe_(spawn|send|wait|kill|list|mode|prewalk)$/.test(innerTool)) {
      return innerTool;
    }
  }
  return null;
}

function handlePreToolUse(input) {
  const convId = input.conversationId;
  const toolCall = input.toolCall || {};
  const toolName = String(toolCall.name || '');
  const toolArgs = toolCall.args || {};

  const state = loadState();

  // 1. If this is a spawned Worker cascade, allow all normal coding tools, block recursive vibe tools
  if (convId && state.workers && state.workers[convId]) {
    const vibeTool = resolveVibeMcpToolName(toolName, toolArgs);
    if (vibeTool || toolName === 'invoke_subagent' || toolName === 'define_subagent') {
      process.stdout.write(
        JSON.stringify({
          decision: 'deny',
          reason:
            'Worker sessions cannot spawn or control nested Vibe workers. Complete the assigned task directly using your coding tools.',
        })
      );
      return;
    }
    process.stdout.write(JSON.stringify({ decision: 'allow' }));
    return;
  }

  const session = (convId && state.sessions && state.sessions[convId]) || { enabled: false };
  const vibeTool = resolveVibeMcpToolName(toolName, toolArgs);

  if (vibeTool === 'vibe_mode' || vibeTool === 'vibe_prewalk') {
    process.stdout.write(JSON.stringify({ decision: 'allow' }));
    return;
  }

  // 2. When Vibe Mode is ON for this Main Session (Director Mode)
  if (session.enabled) {
    if (
      vibeTool ||
      toolName === 'read_file' ||
      toolName === 'view_file' ||
      toolName === 'invoke_subagent' ||
      toolName === 'send_message' ||
      toolName === 'manage_subagents' ||
      toolName === 'define_subagent' ||
      toolName === 'schedule' ||
      toolName === 'ask_question' ||
      toolName === 'list_resources' ||
      toolName === 'read_resource'
    ) {
      if (toolName === 'define_subagent') {
        const subName = String(toolArgs.Name || '').toLowerCase().trim();
        if (subName === 'vibe-worker' || subName.includes('worker')) {
          process.stdout.write(
            JSON.stringify({
              decision: 'deny',
              reason:
                '[OMP Vibe Mode] 严禁定义临时 "vibe-worker"。内置的 "vibe-fast"（Flash 轻量工作机）与 "vibe-good"（Pro 高智力工作机）已完全就绪，请直接通过 invoke_subagent 调用（TypeName 必须严格指定为 "vibe-fast" 或 "vibe-good"，上面的 Role 必须使用中文）。',
            })
          );
          return;
        }
      }

      if (toolName === 'invoke_subagent') {
        const tName = String(toolArgs.TypeName || '').toLowerCase().trim();
        const role = String(toolArgs.Role || '').trim();
        const model = String(toolArgs.Model || '').toLowerCase().trim();
        const overwrite = {};

        // Force TypeName to strictly be 'vibe-fast' or 'vibe-good' (never 'vibe-worker')
        if (tName === 'vibe-worker' || tName === 'self' || !tName || (tName !== 'vibe-fast' && tName !== 'vibe-good')) {
          const isGood =
            model === 'pro' ||
            role.toLowerCase().includes('good') ||
            role.includes('高智力') ||
            role.includes('架构') ||
            role.includes('设计') ||
            role.includes('重构') ||
            role.includes('分析') ||
            role.includes('审计');

          overwrite.TypeName = isGood ? 'vibe-good' : 'vibe-fast';
          overwrite.Model = isGood ? 'pro' : 'flash';
        } else if (tName === 'vibe-fast' && !toolArgs.Model) {
          overwrite.Model = 'flash';
        } else if (tName === 'vibe-good' && !toolArgs.Model) {
          overwrite.Model = 'pro';
        }

        if (Object.keys(overwrite).length > 0) {
          process.stdout.write(
            JSON.stringify({
              decision: 'allow',
              overwrite,
            })
          );
          return;
        }
      }
      process.stdout.write(JSON.stringify({ decision: 'allow' }));
      return;
    }

    process.stdout.write(
      JSON.stringify({
        decision: 'deny',
        reason: `[OMP Vibe Mode — Director Tool Lock] Direct execution tool "${toolName}" is DISABLED while Vibe Mode is ON. As Director, you must NEVER edit files, write files, or run commands directly. Use ONLY \`read_file\` to verify files, and delegate all work to \`vibe-fast\` (flash) or \`vibe-good\` (pro) workers (or \`vibe_spawn\`/\`vibe_send\`).`,
      })
    );
    return;
  }

  // 3. When Vibe Mode is OFF (Normal Mode)
  if (vibeTool && vibeTool !== 'vibe_mode' && vibeTool !== 'vibe_prewalk') {
    process.stdout.write(
      JSON.stringify({
        decision: 'deny',
        reason: `[OMP Vibe Mode] Worker tool "${vibeTool}" is CLOSED while Vibe Mode is OFF. Run \`/vibe on\` (or call \`vibe_mode\` with \`action: "on"\`) first to enter Director Mode and unlock worker communication tools.`,
      })
    );
    return;
  }
  // 4. Prewalk gate (Normal Mode only — Vibe Mode returned above): observe, never block.
  // `manage_task` opens the todo gate; the first `edit_file`/`write_file` after that
  // consumes the one-shot handoff (the edit itself is still made by the planning model).
  if (convId && state.sessions && state.sessions[convId]) {
    const pwSession = state.sessions[convId];
    const pw = getPrewalk(pwSession);
    if (pw.armed) {
      if (toolName === 'manage_task') {
        pwSession.prewalk.todoSeen = true;
        pwSession.updatedAt = Date.now();
        saveState(state);
        process.stdout.write(JSON.stringify({ decision: 'allow' }));
        return;
      }
      if (toolName === 'edit_file' || toolName === 'write_file') {
        if (!pw.todoSeen) {
          pwSession.prewalkNeedsTodo = true;
          pwSession.updatedAt = Date.now();
          saveState(state);
          process.stdout.write(JSON.stringify({ decision: 'allow' }));
          return;
        }
        pwSession.prewalk = {
          armed: false,
          into: pw.into,
          todoSeen: true,
          done: true,
          justSwitched: true,
          handedOffAt: Date.now(),
        };
        pwSession.updatedAt = Date.now();
        saveState(state);
        process.stdout.write(JSON.stringify({ decision: 'allow' }));
        return;
      }
    }
  }

  process.stdout.write(JSON.stringify({ decision: 'allow' }));
}

const mode = process.argv[2];
const input = await readStdinJson();
if (mode === 'pre-invocation') {
  handlePreInvocation(input);
} else if (mode === 'pre-tool') {
  handlePreToolUse(input);
} else {
  process.stdout.write(JSON.stringify({}));
}
