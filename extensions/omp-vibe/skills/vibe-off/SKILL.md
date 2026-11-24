---
name: vibe-off
description: >-
  Immediately disables OMP Vibe Mode (/vibe off): exits Director mode, terminates
  any active Vibe workers, and restores all normal coding tools (`edit_file`,
  `write_file`, `run_command`, etc.) on the main session.
---

# Disable OMP Vibe Mode (`/vibe-off` / `/vibe off`)

This command is intercepted by the `omp-vibe` `PreInvocation` hook to immediately switch Vibe Mode **OFF** for the current conversation without consuming a model turn.
If the model is invoked, call `vibe_mode({ action: "off" })` and confirm that normal tools are restored.
