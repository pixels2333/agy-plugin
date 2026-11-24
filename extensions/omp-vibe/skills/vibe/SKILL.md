---
name: vibe
description: >-
  Activates oh-my-pi (omp) Vibe Mode (/vibe): disables direct execution tools
  (`edit_file`, `write_file`, `run_command`, `manage_task`, `search_web`) on the main
  session via PreToolUse hook, leaves only `read_file` for verification, and unlocks
  the 5 Vibe worker-communication tools (`vibe_spawn`, `vibe_send`, `vibe_wait`,
  `vibe_kill`, `vibe_list`) from the `omp-vibe` MCP server.
---

# OMP Vibe Mode (`/vibe`) — Tool Sandboxing & Worker Communication Suite

When `/vibe` is triggered, the `omp-vibe` plugin's lifecycle hooks (`hooks.json`) and MCP server (`mcp_config.json`) replicate `oh-my-pi`'s exact **Vibe Mode** tool-switching architecture:

## 1. Main Session Tool Lock (`hooks.json` -> `PreInvocation` + `PreToolUse`)

1. **Direct Execution Tools are HARD-DISABLED (`decision: "deny"`) on the Main Session**:
   - `edit_file` — **DISABLED**
   - `write_file` — **DISABLED**
   - `run_command` — **DISABLED**
   - `manage_task` — **DISABLED**
   - `search_web` — **DISABLED**
   - `generate_image` — **DISABLED**
2. **Read-Only Verification Remains Open**:
   - `read_file` / `view_file` — **ENABLED** (so the Director can independently verify every worker's claims).
3. **Worker Communication Tool Suite (`omp-vibe` MCP Server) is UNLOCKED**:
   - `vibe_spawn({ cli: "fast" | "good", prompt, name? })`
   - `vibe_send({ session, message })`
   - `vibe_wait({ sessions?, timeout? })`
   - `vibe_kill({ session })`
   - `vibe_list({})`
   - `vibe_mode({ action: "on" | "off" | "toggle" | "status" })`

> [!NOTE]
> If the user asks to enter or exit Vibe Mode in natural language without typing `/vibe` at the start of the message, call `vibe_mode({ action: "on" })` (or `"off"`) from the `omp-vibe` MCP server first to flip the `PreToolUse` tool lock!

---

## 2. How to Call the 5 Vibe Worker Tools (`omp-vibe` MCP Server)

Call the tools exposed by the `omp-vibe` MCP server (either directly as `mcp_omp-vibe_vibe_*` if eagerly loaded, or via `call_mcp_tool` with `ServerName: "omp-vibe"`):

| Tool | Arguments | Behavior |
| :--- | :--- | :--- |
| **`vibe_spawn`** | `{ cli: "fast" \| "good", prompt: string, name?: string }` | Spawns a persistent background coding worker (`fast` -> `gemini-3.8-flash-medium`, `good` -> `gemini-4-argon-medium`) with full write & terminal tools. Returns immediately with the session ID (`name`). |
| **`vibe_send`** | `{ session: string, message: string }` | Sends a follow-up instruction, correction, or review request to an existing worker session (`session`). Retains full conversation history; if running, queues for the next automatic turn; if idle, starts a new turn immediately. |
| **`vibe_wait`** | `{ sessions?: string[], timeout?: number }` | Blocks until at least **ONE** watched worker finishes its current turn (or `timeout` seconds elapse, default `30`), returning `<vibe-turn>` with its tool-call activity trace, response, and the live TV Wall. |
| **`vibe_kill`** | `{ session: string }` | Terminates a worker session, aborts any running turn, and removes it from the active wall while keeping its transcript readable. |
| **`vibe_list`** | `{}` | Displays the live **TV Wall** roster of all active and idle workers (`id`, `cli`, `state`, `turns`, `model`, tool trace, output tail) plus killed worker IDs. |
| **`vibe_mode`** | `{ action: "on" \| "off" \| "toggle" \| "status" }` | Toggles or checks the main session's Vibe Mode tool lock. Calling with `"off"` terminates all remaining workers in the scope and restores normal coding tools (`edit_file`, `run_command`, etc.). |

---

## 3. Director Operating Protocol (`<vibe-mode>`)

1. **Ensure Vibe Mode Lock is ON**:
   If `PreInvocation` already activated Vibe Mode (via `/vibe`), proceed immediately. Otherwise call `vibe_mode({ action: "on" })`.
2. **Split into Independent Workstreams**:
   One persistent worker session per workstream. Spawn once with `vibe_spawn`, then use `vibe_send` on the **SAME** session ID for follow-ups; **NEVER respawn** a second session for the same workstream.
3. **Spawn Concurrent Workers (`vibe-fast` + `vibe-good`)**:
   - **Role (上面的名字 / 面板顶部标题)**: 必须严格使用清晰具体的**中文**角色名（例如：`古明地恋字节码反编译器与重构器`、`符卡逻辑移植员`、`资产比对审计员`、`自动化测试执行员`），严禁使用英文！
   - **TypeName (下面的类型标签 / 输入框徽章)**: 必须严格且仅指定为 `vibe-fast` 或 `vibe-good`，严禁使用 `vibe-worker`、`self` 或任何临时自定义名称！
   - `vibe-fast` (`flash`): mechanical, well-specified work — renames, small fixes, boilerplate, data collection, running tests, output reports.
   - `vibe-good` (`pro`): architecture design, tricky debugging, multi-file refactors, judgment-heavy work, reviewing `fast` output.
   Include complete self-contained briefs (file paths, constraints, acceptance criteria) because workers start blank and never see the Director's conversation.
4. **Wait & Verify with `read_file`**:
   - After spawning/sending to all concurrent workstreams, call `vibe_wait` to collect settled `<vibe-turn>` results.
   - On each result, **MUST call `read_file`** on touched files to verify the worker's claims before building on them or reporting completion.
   - Use `vibe_send` for corrections or next steps, and `vibe_kill` once a workstream is verified and complete.
5. **Exiting Vibe Mode**:
   When the user runs `/vibe` again or asks to exit Vibe Mode, call `vibe_mode({ action: "off" })` to tear down remaining workers and restore all normal tools.
---

## 4. Prewalk one-shot handoff (`/prewalk` / `vibe_prewalk`)

Prewalk plans with strength and implements with speed **in the same normal session** (no tool lock, no workers): arm with `/prewalk` (or `vibe_prewalk({ action: "arm" })`), create ordered todos via `manage_task`, make one representative edit — the first edit after todos consumes the one-shot and steers the next turn into fast implementation mode. Full lifecycle (`arm` / `restart` / `off` / `status`, `into: "fast" | "good"`) lives in the `prewalk` skill; a pending prewalk waits quietly while Vibe Mode is ON.
