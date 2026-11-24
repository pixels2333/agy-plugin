# OMP Vibe Mode (`omp-vibe`) for Google Antigravity

完整复刻 [`oh-my-pi` (`omp`)](https://github.com/can1357/oh-my-pi) 的 **Vibe Mode (`/vibe`)**：通过 **引擎级工具拦截钩子 (`hooks.json`)**、**专用 MCP 工具服务 (`mcp_config.json`)** 与 **内置 `vibe-fast` / `vibe-good` 子代理**，在主会话禁用直接修改/执行工具并开放 Worker 通信工具集，同时无缝对接 **Antigravity 自带的子代理面板（Subagents Panel）**。

---

## 核心机制

1. **主会话工具沙箱锁 (`hooks.json` -> `PreInvocation` + `PreToolUse`)**
   - **激活 Vibe 模式（输入 `/vibe` 或调用 `vibe_mode({ action: "on" })`）**：
     - **硬件级禁用主会话直接执行工具**：`PreToolUse` 钩子强制拦截（`decision: "deny"`）主会话的 `edit_file`、`write_file`、`run_command`、`manage_task`、`search_web`、`generate_image`。
     - **保留只读校验**：仅保留 `read_file` / `view_file` 供 Director 独立审查 Worker 改动。
     - **开放 Worker 通信工具集**：允许通过 `vibe-fast` / `vibe-good` 子代理（原生对接 AGY 自带子代理面板）及 `omp-vibe` MCP 工具集（`vibe_spawn`、`vibe_send`、`vibe_wait`、`vibe_kill`、`vibe_list`、`vibe_mode`、`vibe_prewalk`）与 Worker 通信。
   - **退出 Vibe 模式（再次输入 `/vibe`、`/vibe off` 或调用 `vibe_mode({ action: "off" })`）**：
     - 自动恢复主会话全部常规工具，并关闭 `vibe_*` 专用工具集。

2. **双层级持久化 Worker (`agents/vibe-fast.md` & `agents/vibe-good.md`)**
   - **`vibe-fast` (`fast` / `flash`)**：对应 `omp` 的 `sonic` (`@smol`)，低延迟机械执行（重命名、小补丁、测试运行、信息收集）。
   - **`vibe-good` (`good` / `pro`)**：对应 `omp` 的 `task` (`@task`)，高推理深度任务（架构设计、复杂调试、多文件重构、审查 `fast` 产出）。

3. **Prewalk 一次性交接 (`/prewalk` / `vibe_prewalk`)**
   - **强规划、快执行**：同一主会话内，先用强模型调查仓库、识别风险、用 `manage_task` 建好有序 todo 并做出代表性首改；首改落地后一次性切换到 fast 实现风格继续收尾（`omp` 的 `prewalk`：plan with strength, implement with speed）。
   - **只观察、不拦截**：`PreToolUse` 仅跟踪 todo 门 + 首改触发，不 `deny` 任何工具；与 Vibe 模式正交（Vibe ON 时直接改动被禁，pending 的 prewalk 会静静等待到退出 Vibe）。
   - **命令**：`/prewalk [fast|good]` 武装、`restart` 重武装、`off` 取消、`status` 查询；自然语言请求走 `vibe_prewalk({ action })`。
