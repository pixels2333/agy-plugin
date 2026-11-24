---
name: prewalk
description: >-
  Arms the oh-my-pi (omp) Prewalk one-shot handoff (/prewalk): the current
  session plans with the strong model (investigate, todos, first edit), then
  continues in fast implementation mode. Same lifecycle as vibe_prewalk.
---

# OMP Prewalk (`/prewalk`) — Plan with Strength, Implement with Speed

Prewalk is a **one-shot model handoff inside the SAME normal session** (mirrors
[`oh-my-pi` Prewalk](https://omp.sh/docs/prewalk)). Start on the model you trust:
it investigates the repo, identifies risks, creates an ordered todo list, and
makes the first edit. Once that first edit lands, the session continues in
**fast implementation mode** — same conversation, same tools, execution-style
steering. No extra terminal, no worker dispatch, no tool lock.

> Vibe (`/vibe`) = director + persistent `fast`/`good` workers with a tool lock.
> Prewalk (`/prewalk`) = same session, strong plan first, fast finish after.
> They are independent: a pending prewalk simply waits while Vibe Mode is ON
> (direct edits are denied there, so the first-edit trigger can never fire).

## 1. Slash lifecycle (`hooks.json` -> `PreInvocation` + `PreToolUse`)

| Command | Effect (instant, no LLM turn) |
| :--- | :--- |
| `/prewalk` or `/prewalk fast` | Arm one-shot handoff for `fast` (`@smol` equivalent). Keeps the existing target if already armed. |
| `/prewalk good` | Arm one-shot handoff for `good` (stronger implementation tier). |
| `/prewalk restart` | Return to planning and re-arm (also after a handoff consumed the one-shot). |
| `/prewalk off` | Cancel the pending handoff; session model unchanged. |
| `/prewalk status` | Report armed / handed-off / off state. |

## 2. Handoff trigger (observed by `PreToolUse`, never blocked)

1. **Todo gate** — any `manage_task` call opens the gate (read-only investigation alone does not).
2. **First edit** — the first `edit_file` / `write_file` after todos is still made by the planning model, then consumes the one-shot: the next turn carries the `<prewalk-switched>` implementation checklist.
3. **Reminders, not blocks** — editing before todos only reminds you to create todos first; the handoff stays armed.

## 3. `vibe_prewalk` MCP tool (`omp-vibe` MCP server)

Same lifecycle for natural-language requests (no `/prewalk` prefix typed):

| Arguments | Effect |
| :--- | :--- |
| `{ action: "arm", into: "fast" \| "good" }` | Arm (default `into: "fast"`). Preserves the existing target if already armed. |
| `{ action: "restart", into?: ... }` | Re-arm from the current model. |
| `{ action: "off" }` | Cancel the pending handoff. |
| `{ action: "status" }` (or `{}`) | Report state + TV Wall roster. |

## 4. When to use it

- Broad investigation followed by repetitive call-site updates → strong plan, `fast` finish.
- Clear plan followed by routine tests / mechanical edits → strong plan, `fast` finish.
- Security-sensitive migration, unresolved races, subtle debugging → **skip prewalk**, keep the capable model (or use `/vibe` with a `good` worker for review).
- Small obvious edit → start cheap directly; prewalk adds nothing.

> [!NOTE]
> If the user asks for a plan-then-fast-execute handoff in natural language without typing `/prewalk`, call `vibe_prewalk({ action: "arm" })` first.
