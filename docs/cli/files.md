# `agentboard files`

从文件的角度看历史：哪些文件被 agent 编辑 / 读取过、多少次、涉及几个 session、最后一次是什么时候。数据来自所有 `tool_call` / `plan` part 抽出的 `files`（见 [parts.md](parts.md)），相对路径已按项目根归一为绝对路径。

```
agentboard files [-t <ids>] [-p <text>] [--since <date>] [--until <date>]
                 [--session <key>] [--file <text>] [-n, --limit 50] [--json]
```

| 选项 | 作用 |
| --- | --- |
| `-t` / `-p` / `--since` / `--until` | 与 `list` 相同的 session 级过滤 |
| `--session <key>` | 只看一个 session（等价于 `show <key> --files`） |
| `--file <text>` | 路径包含该文本 |
| `-n` | 行数上限；排序按 `edits×3 + reads` 降序 |
| `--json` | `[{ path, edits, reads, sessions, lastActivity, sessionKeys[] }]` |

## 示例

```
$ agentboard files -n 6
edits  reads  sessions  last              path
─────  ─────  ────────  ────────────────  ─────────────────────────────────────────────────────────
3      10     5         2026-09-06 22:50  /Users/example/code/infra-terraform/src/index.ts
3      5      3         2026-09-04 20:44  /Users/example/code/mobile-app/src/index.ts
3      3      3         2026-09-03 19:50  /Users/example/code/agentboard/src/index.ts
2      6      3         2026-09-05 21:56  /Users/example/research/paper-reproduction/src/index.ts
1      6      2         2026-09-01 19:07  /Users/example/research/paper-reproduction/src/storage/s3.ts
1      5      2         2026-08-31 18:07  /Users/example/code/mobile-app/src/storage/s3.ts
```

`edits` 是 `edit` 类别的调用数，`reads` 是其他类别（read / search…）触达该文件的调用数。

## 常见问法

```bash
# 这个项目里哪些文件被 agent 反复改——热点文件
agentboard files -p mobile-app --since 1m

# 谁动过 auth 中间件？拿到 sessionKeys 再去 show
agentboard files --file middleware/auth --json | jq '.[0].sessionKeys'

# 某个 session 改了哪些文件（两种写法等价）
agentboard files --session codex:019f3d8f
agentboard show codex:019f3d8f --files

# 某个文件的修改历史：先找 session，再看具体的编辑调用
agentboard grep "" -c edit --file src/index.ts --asc
```

## 边界

- 只统计 agent 通过工具触达的文件；agent 在回复里提到的路径不算。
- 抽取依赖参数字段名（`path` / `file_path` / `target_file` …）和 patch 头；工具用了不常见的参数名时可能漏。`derived` 保真度的来源只有 160 字参数摘要，路径太长时会被截断而丢失。
- 路径归一需要 session 有绝对的项目路径；项目未知（`(unknown)`）时相对路径保持原样。
