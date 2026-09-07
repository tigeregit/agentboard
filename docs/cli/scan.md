# `agentboard scan`

刷新索引。默认增量：每个来源文件按 (mtime, size) 指纹判断，没变的不重读；变过的重新解析成 session 摘要 + parts 写入索引，源文件消失的 session 被移除。

```
agentboard scan [-t, --tool <ids>] [--full] [--json] [-q, --quiet]
```

| 选项 | 作用 |
| --- | --- |
| `-t, --tool a,b` | 只扫这些工具 |
| `--full` | 忽略指纹，全部重新解析（解析器升级后、或怀疑索引不一致时用） |
| `--json` | 每个工具一条 `{tool, upserted, removed, partsIndexed, warnings, durationMs, error?}` |
| `-q, --quiet` | 不在 stderr 打进度 |

## 示例

```
$ agentboard scan
tool              updated  removed  parts  time  status
────────────────  ───────  ───────  ─────  ────  ──────
copilot-cli       3        0        3      17ms  ok
copilot-desktop   3        0        3      4ms   ok
vscode-copilot    6        2        4      5ms   ok
opencode          4        0        4      6ms   ok
codex             5        0        5      7ms   ok
cursor            8        0        8      10ms  ok
claude-code       6        0        6      10ms  ok
…

Index: 113 sessions · 33 tools · 15 projects · 1284 parts (/tmp/agentboard-demo-home/.agentboard/index.db)
```

| 列 | 含义 |
| --- | --- |
| `updated` | 本次重新解析并写入的 session 数（增量扫描时通常是 0 或很小） |
| `removed` | 源文件消失而被删除的 session 数 |
| `parts` | 本次（重新）索引了 parts 的 session 数。首次升级到 part 模型时，这里会等于全部 session 数——回填 |
| `status` | `ok` / `N warnings` / `ERROR …`。告警内容用 `--json` 看 `warnings[]` |

## 什么时候需要手动 scan

通常不需要：查询命令会自动做增量扫描；Web 看板也每 60 秒自己刷。手动跑的场景：

- **刚升级**：`agentboard scan` 一次，让所有 session 回填 parts（本机 300 个 session 约 10 秒）。
- **解析器改了**：`agentboard scan --full -t codex` 重新解析某个工具。
- **cron / 自动化**：`agentboard scan --json >/dev/null && agentboard summary --period week` 确保摘要基于最新数据。
- **看告警**：`agentboard scan --json | jq '.[] | select(.warnings|length>0)'`。

## 增量的边界

- 文件类来源（Codex、Claude Code、Kimi…）按文件粒度增量。
- Cursor IDE 的 `state.vscdb` 是一个大库，任一 composer 变化都会整库重读（1–2 秒）。
- OpenCode 的 API 模式每次都查。
- 一个来源文件如果现在解析出的 session 集合变了（例如被压缩），旧 key 会被清掉。
