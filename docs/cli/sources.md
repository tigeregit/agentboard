# `agentboard sources`

列出所有支持的工具：本机是否检测到、读取策略、已索引的 session 数、最后活动时间，以及上次扫描的告警。这是"为什么我的 session 没出现"的第一站。

```
agentboard sources [--json]
```

`sources` 不触发自动扫描（它本身就是在看索引现状）。

## 示例

```
$ agentboard sources
id                tool                            found  sessions  last activity     via
────────────────  ──────────────────────────────  ─────  ────────  ────────────────  ────────────
copilot-cli       GitHub Copilot CLI              yes    3         2026-09-03 22:37  file
copilot-desktop   GitHub Copilot app (desktop)    yes    3         2026-09-02 21:37  native-index
vscode-copilot    VS Code Copilot Chat            yes    4         2026-09-07 19:43  file
opencode          OpenCode                        yes    4         2026-08-31 17:57  api
codex             Codex CLI                       yes    5         2026-08-31 23:51  file
cursor            Cursor                          yes    8         2026-09-07 23:37  sqlite
grok-build        Grok Build                      yes    4         2026-09-05 00:17  file
claude-code       Claude Code                     yes    6         2026-09-06 22:51  file
pi                pi coding agent                 yes    3         2026-08-31 19:51  file
kimi              Kimi Code / Kimi CLI            yes    4         2026-09-07 20:57  native-index
…

• trae: Trae IDE ModularData database is SQLCipher-encrypted and skipped; if a chat is missing, export it from Trae and import with `agentboard import`.
• aider: no .aider.chat.history.md found in the default code roots; set AGENTBOARD_AIDER_DIRS for projects elsewhere

Strategies: api = tool's own query API, native-index = index maintained by the tool, sqlite/file = parse private store, import = official export.
Run `agentboard sources --json` for per-tool strategy details and probed paths.
```

列含义：

| 列 | 含义 |
| --- | --- |
| `id` | 工具 id，`-t/--tool` 就填它 |
| `found` | 本机是否存在该工具的存储目录 / 数据库 |
| `sessions` | 索引中的 session 数（`no` 但有数说明是历史遗留或导入） |
| `via` | 当前生效的读取策略：`file` 解析私有文件格式、`sqlite` 读私有数据库、`native-index` 用工具自带索引、`api` 调工具 API、`import` 只能靠官方导出 |
| 最后一列 | 上次扫描的告警数 |

表格后面的 `•` 备注是 adapter 对特殊情况的说明（加密数据库、目录被其他工具共用、需要设置环境变量等）。

## `--json`

每个工具一条记录，包含：`strategies[]`（每种策略的 kind / status / description）、`detection.locations[]`（探测过的路径及是否存在）、`detection.notes[]`、`configHints[]`（该 adapter 认哪些环境变量）、`lastScan`。排查"检测不到"就看 `locations`：

```bash
agentboard sources --json | jq '.[] | select(.id=="cursor") | .detection.locations'
```

## 什么时候用

- 装了新 agent 想确认有没有被识别。
- `list -t xxx` 返回空，先看这里 `found` 是不是 `no`、有没有告警。
- 想知道某个工具的存储在哪（`--json` 的 `locations`）或能不能改路径（`configHints`）。
