# Antigravity · API 用量统计看板

给 Antigravity 桌面版做一个本地 API 用量统计界面。读本地数据、只读不改动应用本体，
不影响应用升级，也不会因为换版本失效。

## 快速开始

双击 `start.cmd`，或：

```bash
python server.py --open
```

浏览器打开 <http://127.0.0.1:8787/> 即可。端口可用 `--port 9000` 或环境变量
`AGY_STATS_PORT` 修改。关闭命令行窗口即停止服务。

只生成一份快照（不起服务）：

```bash
python collect.py        # 输出 stats.json
```

## 数据来源与口径

数据全部来自 `~/.gemini/antigravity/`（即 `C:\Users\<你>\.gemini\antigravity`）：

| 指标 | 来源 | 口径 |
|---|---|---|
| API 请求数 | `conversations/<id>.db` → `gen_metadata` | **每次上游模型调用一行**，含模型枚举与 request_id |
| 模型分布 | 同上 → `model_enum` | 按请求数计，非按会话 |
| 每日请求 | 同上，用 `last_step_index` 对齐 transcript 的时间戳 | 86/88 个会话可对齐，其余不计入日粒度 |
| 工具调用 | `brain/<id>/.system_generated/logs/transcript.jsonl` | 统计 `tool_calls[].name` |
| 步骤 / 思考步 | transcript 的 `source=MODEL` 记录 | 步骤数另取自 `steps` 表 |
| 历史 token | `token_usage.jsonl` | **旧版本遗留样本**，见下 |
| 会话标题 | transcript 首条用户输入 | 取首行，截断 120 字 |

### 重要：为什么没有实时的 token 统计

当前版本（2.12.2）**不在本地落地每次请求的 token 数**。已核实：

- `language_server.exe` 内部已无 `token_usage` 写入逻辑（符号搜不到）；
- `token_usage.jsonl` 最后写入停留在 2026-06-26，是旧版遗留；
- 会话库 `gen_metadata` 的字段只有 `sessionID / model_enum / trajectory_id /
  request_id / used_claude / used_non_gemini_model / last_step_index`，没有 token；
- transcript 的每条记录只有 `step_index / source / type / status / created_at /
  content / thinking / tool_calls`，没有 token。

所以本看板统计的是**可本地取证的请求量口径**。页面底部的"历史 Token 用量"是 2026-06
那批遗留样本（15 次请求、266,710 token），用来演示 token 面板的形态，不代表当前用量。

### 真正的额度/成本数据在哪

应用使用的是**服务端积分（Credit）账目模型**。二进制里可见的相关接口：

```
GetCreditUsageSummary   GetConsumedCredits     GetAvailableCredits
GetAvailableFlexCredits GetAvailableFlowCredits GetAvailablePromptCredits
GetCredits              GetCreditCost          GetCreditMultiplier
GetFlexCreditQuota      GetFlowCreditsUsed     GetMonthlyFlowCredits
GetCanBuyMoreCredits    CreditChronicleEntry   CreditPercentages
```

这些走 `https://cloudcode-pa.googleapis.com/v1internal`，需要登录态（应用持有的 OAuth
令牌），本地没有缓存。想把这套数据接进看板，需要在应用运行时抓一次它的本地接口
（语言服务器把界面和这些 API 打通，令牌不下发到磁盘）。这属于后续可选项，需要时再做。

## 模型名称映射

`model_enum` 是 `MODEL_PLACEHOLDER_M###` 形式的枚举，界面上的友好名称是推断出来的：
拿 transcript 里 "`Model Selection` from X to Y" 的设置变更事件，和请求的枚举序列对齐投票
（见 `infer_models.py`）。当前结果：

| 枚举 | 名称 | 请求数 | 置信度 |
|---|---|---|---|
| `MODEL_PLACEHOLDER_M298` | Gemini 3.7 Flash (High) | 4110 | 高（23 票） |
| `MODEL_PLACEHOLDER_M318` | Gemini 3.8 Flash (High) | 2377 | 高（18 票） |
| `MODEL_PLACEHOLDER_M71` | Gemini 3.6 Flash (High) | 655 | 高（12 票） |
| `MODEL_PLACEHOLDER_M264` | Gemini 3.6 Flash (High) | 12 | 低（1 票） |
| `MODEL_PLACEHOLDER_M322` | 未识别 | 25 | — |

映射写在 `model_map.json`，直接改这个文件即可覆盖，不必动代码。出现新模型后可跑：

```bash
python infer_models.py      # 重新投票推断
```

## 文件说明

| 文件 | 作用 |
|---|---|
| `collect.py` | 采集与聚合，产出 `stats.json` |
| `server.py` | 本地 HTTP 服务：`/` 页面、`/api/stats` 数据、`/api/health` |
| `index.html` | 看板页面，纯原生 SVG 图表，无外部依赖、可离线 |
| `model_map.json` | 模型枚举 → 显示名 |
| `infer_models.py` | 模型映射推断脚本（排查用） |
| `probe_schema.py` | 会话库结构探测脚本（排查用） |
| `start.cmd` | 双击启动 |
| `stats.json` | 最近一次采集快照 |
| `tokens.py` | 全量采集 token 用量（走本地 RPC）→ `tokens.json` |
| `rpc.py` | 调单个 RPC 并打印响应结构（排查用） |
| `extensions/` | Antigravity UI 扩展插件集（支持开发与存放多个扩展） |
| `injector/` | 应用内悬浮注入面板相关脚本，见下 |

## 目录

```
antigravity-api-stats/
├─ collect.py  server.py  index.html  start.cmd   ← 独立 Web 看板
├─ tokens.py   rpc.py   model_map.json            ← Token 与 RPC 采集
├─ extensions/                                    ← UI 扩展插件集目录
│  └─ agy2-stream-stats/                          ← 监控插件（已联接至全局插件目录）
│     ├─ plugin.json                              ← 插件清单声明
│     ├─ assets/logo.svg                          ← 插件图标
│     └─ sidecars/panel/                          ← 监控面板前端与 Node.js 宿主服务
│        ├─ sidecar.json package.json
│        ├─ main.mjs                              ← 后端：自动探测 LS 端口/CSRF 并转发 RPC
│        ├─ index.html app.js styles.css          ← 前端：Apple 风格用量与额度监控面板
└─ injector/                                      ← 应用内悬浮注入面板（CDP / patch 方式）
   ├─ panel.js        注入的浮层本体
   ├─ panel-host.js   常驻伴随脚本
   ├─ inject.js       一次性注入 / 移除
   ├─ verify.js       导航到会话并截图
   ├─ capture.js      抓渲染进程↔LS 的真实请求
   └─ check.js check2.js  面板渲染检查
```

## 已知限制

- 会话库正在被应用写入时，读取使用 SQLite 只读模式（`mode=ro`），不会加锁干扰应用。
- 极少数没有 transcript 的会话（88 个里有 2 个）只参与请求数与模型统计，不参与日粒度。
- 请求数按 `gen_metadata` 行数计。若某次调用失败重试，会体现为多行。
- 数据目录路径按 `~/.gemini/antigravity` 硬编码，迁移过用户目录的话改 `collect.py:24`。

---

# 应用内统计面板（token / 上下文占用 / 额度）

## 结论：token 数据能拿到，而且不在磁盘上

之前在本 README 里写过"本地不落地 token"——**这句话对文件成立，对接口不成立**。
真实来源是应用本地 language server 的 RPC：

```
POST https://127.0.0.1:<UI端口>/exa.language_server_pb.LanguageServerService/<方法>
Header: x-codeium-csrf-token: <从 GET / 的 HTML 里 window.__APP_CONFIG__.csrfToken 取>
```

关键接口：

| 方法 | 内容 |
|---|---|
| `GetUserStatus` | 套餐、`availablePromptCredits`、`availableFlowCredits`、每个模型的 `quotaInfo.remainingFraction` 与 `resetTime` |
| `GetCascadeTrajectoryGeneratorMetadata` | **逐次模型调用**：`usage.inputTokens/outputTokens/thinkingOutputTokens/responseOutputTokens`、`chatStartMetadata.contextWindowMetadata.estimatedTokensUsed/maxContextTokens`、`timeToFirstToken`、`responseModel`（官方模型名） |

CSRF 令牌在 HTML 里明文下发，所以**不需要改应用、不需要代理、不需要证书**就能读这些数据。

## 实测数据（全量 88 个会话）

```
调用次数     7,154
Prompt 总输入  826,209,690  = 新处理 54,787,434 + 缓存命中 771,422,256（命中率 93.4%）
输出           3,888,949
思考           1,650,993
总计           830,098,639
上下文峰值       255,903 / 256,000
TTFT          p50 3.73s / p90 8.34s
模型           gemini-3.7-flash 428M、gemini-3.8-flash 255M、gemini-3.7-flash-exp-b 67M …
```

### token 口径（重要）

`usage` 一共 10 个字段，token 相关的必须理解对：

| 字段 | 含义 |
|---|---|
| `inputTokens` | **本轮新处理**的 prompt token（不含缓存部分） |
| `cacheReadTokens` | **命中缓存复用**的 prompt token |
| `outputTokens` | 输出（含思考） |
| `thinkingOutputTokens` | 输出中的思考部分 |

`cacheReadTokens` **不是** `inputTokens` 的子集，两者互补：
**完整 prompt = inputTokens + cacheReadTokens**。

验证方式：取上下文占用最大的几次调用，`inputTokens + cacheReadTokens` 与
`contextWindowMetadata.estimatedTokensUsed` 高度吻合，只差约 1,100 的固定余量：

```
ctxUsed=255,332   in=4,446   cache=249,854   in+cache=254,300   diff=-1,032
ctxUsed=249,639   in=2,739   cache=245,797   in+cache=248,536   diff=-1,103
```

只看 `inputTokens` 会把总量少算约一个数量级——agentic 长会话里约 93% 的 prompt
来自缓存复用。

## 文件（都在 `injector/`）

| 文件 | 作用 |
|---|---|
| `panel.js` | 注入到应用页面的浮层面板：套餐额度 / 上下文占用 / 会话统计 / 本会话 token |
| `panel-host.js` | 常驻伴随脚本：附加 CDP、注入面板、页面跳转后自动重注入 |
| `inject.js` | 一次性注入（`--screenshot` 出图，`--eject` 移除） |
| `capture.js` | 抓 渲染进程↔LS 的真实请求（`RELOAD=1` 会重载页面） |
| `verify.js` | 导航到指定会话并截图验证面板 |
| `check.js` `check2.js` | 面板 DOM 渲染检查（`check2` 用 `textContent`，不受滚动裁切影响） |

## 用法

```bash
cd injector
node panel-host.js          # 常驻，用应用时挂着（页面跳转会自动重注入）
node inject.js --eject      # 移除面板
cd .. && python tokens.py   # 全量 token 统计（读本地 RPC，输出 tokens.json）
python tokens.py --limit 5  # 只跑前 5 个会话
```

## 注意

- 面板数据全部来自本地接口，**不产生任何额外的上游请求**（不消耗额度）。
- `capture.js` 的 `RELOAD=1` 会整页重载应用窗口；SPA 重载有可能新建一个空会话视图，
  不想这样就不要用 `RELOAD=1`，需要重新注入时用 `panel-host.js`。
- CDP 的 `Page.addScriptToEvaluateOnNewDocument` 注册在调试会话断开后会失效，
  所以 `panel-host.js` 采用"检测到缺失就重新 evaluate"的方式维持面板。
- 想让面板**开机就在、不依赖伴随脚本**，只能改 `app.asar` 里的 `dist/preload.js`；
  代价是应用升级会被覆盖，需要重打补丁。

## 额度口径

`GetUserStatus.cascadeModelConfigData.clientModelConfigs[]` 里每个模型各带一份
`quotaInfo.remainingFraction`，而且**不同池子数值不同**：实测 Gemini 系列 77.1%，
而 Claude / GPT-OSS 为 100%。另外**数组顺序不稳定**，不能取 `[0]` 当整体剩余。
面板取的是**所有池子里的最低值**，并标注是哪个模型，这样才是真正会先撞到的那条线。

## 面板里的三个计数指标

`GetCascadeTrajectory` 一次调用同时给出：

| 指标 | 取法 |
|---|---|
| 模型调用 | `trajectory.generatorMetadata[]` 中带 `usage` 的条数（等价于顶层 `numTotalGeneratorMetadata`）|
| 工具调用 | 递归累加所有 `steps[].toolCalls` 数组的元素个数 |
| Agent 步骤 | 顶层 `numTotalSteps`（等价于 `steps.length`）|

注意 `trajectory_verbosity=CLIENT_TRAJECTORY_VERBOSITY_PROD_UI` 能把响应从 9 MB 压到
2.6 MB，但**会把 `toolCalls` 裁掉**（工具调用数变 0），所以计算工具调用必须用默认（full）。

### 与文件口径的差异

- 模型调用：接口口径 7,154 vs 会话库 `gen_metadata` 行数 7,179（少数子轨迹/重建差异）。
- 工具调用：接口数的是**执行器实际落成的步骤里的工具调用**，日志（transcript 的 `tool_calls`）
  数的是**模型请求的工具**。实测某会话 62 vs 63，逐个工具对比只差一个 `view_file`。

两个口径都对，但不要混用：面板统一用接口口径，独立看板统一用文件口径。

## 面板能否改用磁盘数据？

数据层面可以，但面板用不了：

| 指标 | 磁盘来源 | 与接口是否一致 |
|---|---|---|
| Agent 步骤 | `conversations/<id>.db` → `steps` 表 `count(*)` | **完全一致**（实测 136 = 136）|
| 模型调用 | 同库 → `gen_metadata` 行数 | **完全一致**（实测 68 = 68）|
| 工具调用 | `brain/<id>/.../transcript.jsonl` 的 `tool_calls` | 差 1（62 vs 63，口径不同）|
| 时间戳/延迟 | transcript 的 `created_at` | 延迟接口才有 |

**面板读不了文件**：渲染进程 `nodeIntegration:false` + `contextIsolation:true`，没有 `fs`。
要让它用磁盘数据，只能再起一个本地辅助服务（面板 fetch 它，需 CORS），或改 preload
用 `fs` 读文件桥给页面（需改 `app.asar`）。

**不建议这么做**，因为：

1. `token` 和上下文占用**从未落盘**，步骤走磁盘也仍要调接口 → 两处都读，更复杂；
2. 会话库是应用异步写入的，**正在使用的会话可能还没刷盘**，面板会滞后于实时状态；
3. 接口一次 `GetCascadeTrajectory` 就同时给出步骤/模型调用/工具调用/token/上下文/延迟，
   且步骤与模型调用和磁盘数字完全对齐，没有必要绕路。

磁盘那条路径留给**独立看板**——它本来就是离线读文件的。
