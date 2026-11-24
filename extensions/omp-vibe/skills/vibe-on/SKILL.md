---
name: vibe-on
description: >-
  Immediately enables OMP Vibe Mode (/vibe on): disables direct edit/write/command
  tools on the main session and unlocks Worker communication tools (`vibe-fast` /
  `vibe-good` subagents and `vibe_*` tools).
---

# Enable OMP Vibe Mode (`/vibe-on` / `/vibe on`)

This command is intercepted by the `omp-vibe` `PreInvocation` hook to immediately switch Vibe Mode **ON** for the current conversation.
If the hook did not terminate early (e.g. if additional instructions were provided), call `vibe_mode({ action: "on" })` and proceed as the **Vibe Mode Director**.
