# `agentboard list` / `ls`

按条件列 session，最新的在前。这是定位层：每条记录只有 key、标题、项目、时间、轮数——放心列 50 条也不会撑爆上下文。

```
agentboard list [-t, --tool <ids>] [-p, --project <text>] [--since <date>] [--until <date>]
                [-s, --search <text>] [--surface cli|ide|desktop|web]
                [-n, --limit <n>] [--offset <n>] [--asc] [--keys] [--json [--full]]
```

## 过滤器（`list` / `search` / `projects` / `tools` 共用）

| 选项 | 作用 |
| --- | --- |
| `-t, --tool cursor,codex` | 工具 id，逗号分隔；未知 id 报错并列出可用值 |
| `-p, --project infra` | 项目路径或名字包含该文本 |
| `--since 7d` / `--until 2026-09-01` | 按 session 活动时间；格式见 [README](README.md#日期) |
| `-s, --search text` | 标题 / 提示词 / 项目名 / 模型名包含（等价于 `search` 命令） |
| `--surface cli` | 只看 CLI / IDE / 桌面 / 网页来源 |

## 分页与排序

| 选项 | 作用 |
| --- | --- |
| `-n, --limit 50` | 最多几行（上限 2000） |
| `--offset 0` | 跳过几行 |
| `--asc` | 最旧的在前 |

## 输出形态

| 选项 | 作用 |
| --- | --- |
| （默认） | 对齐表格 |
| `--keys` | 只输出 key，一行一个——喂给循环或 `xargs` |
| `--json` | `{ total, items }`，`items` 是精简记录 |
| `--json --full` | 完整的 `SessionSummary`（含 `promptText`、`source`、`extra`），体积大约 8 倍 |

## 示例

```
$ agentboard list -n 8
started           tool         project             title                                                         turns/calls  dur   key
────────────────  ───────────  ──────────────────  ────────────────────────────────────────────────────────────  ───────────  ────  ─────────────────────────────────────────────────
2026-09-07 23:37  Goose        mobile-app          goose-37c71ca4                                                3p/1t        13m   goose:20260907_153755
2026-09-07 23:37  Cursor       mobile-app          Create a Dockerfile with a multi-stage build for the API      3p/3t        <1m   cursor:9faf37c3-abcd-4f01-8345-6789abcdef01
2026-09-07 22:37  Antigravity  antigravity         Antigravity session 555d9ae0                                  2p/0t        6m    antigravity:555d9ae0-abcd-4f01-8345-6789abcdef01
2026-09-07 20:37  Kimi         agentboard          Kimi CLI legacy session                                       3p/3t        20m   kimi:d2cfa083-abcd-4f01-8345-6789abcdef01
2026-09-07 19:37  VS Code      mobile-app          Create a Dockerfile with a multi-stage build for the API      2p/2t        6m    vscode-copilot:54723a10-abcd-4f01-8345-6789abcdef01
…

8 of 113 shown (use --limit/--offset)
```

`turns/calls` 列：`3p/3t` = 3 个人类提问（turn）/ 3 次工具调用。

```
$ agentboard list -t claude-code,codex --since 14d --keys
claude-code:32e1e853-abcd-4f01-8345-6789abcdef01
claude-code:32e1e854-abcd-4f01-8345-6789abcdef01
…
```

```
$ agentboard list --json -n 2
{
  "total": 113,
  "items": [
    {
      "key": "goose:20260907_153755",
      "tool": "goose",
      "project": "mobile-app",
      "projectPath": "/Users/example/code/mobile-app",
      "title": "goose-37c71ca4",
      "startedAt": "2026-09-07T15:37:55.000Z",
      "endedAt": "2026-09-07T15:50:55.000Z",
      "turns": 3,
      "toolCalls": 1,
      "messages": 8
    },
    …
  ]
}
```

精简记录还可能带 `model` 和 `parentKey`（子 agent 的父 session）。

## 组合用法

```bash
# 上周在 infra 项目里用 Cursor 干了什么
agentboard list -t cursor -p infra --since 7d

# 找最长的会话：JSON + jq 按 toolCalls 排序
agentboard list --since 1m --json -n 500 | jq '.items | sort_by(-.toolCalls) | .[:5]'

# 对每个 session 取大纲
agentboard list -p mobile-app --since 7d --keys | while read k; do agentboard show "$k" --summary; done
```

## 注意

- 时间排序依据是 `endedAt`（最后活动），所以一个持续两天的 session 会排在它结束的位置。
- `--search` 只搜索 session 级字段（标题、用户提示词、项目、模型）。要搜 transcript 内容——工具输出、助手回复、命令——用 [`grep`](grep.md)。
