# `agentboard summary`

一段时间（日 / 周 / 月）的活动摘要：总量、按工具、按项目、按项目分组的 session 清单。Markdown 可以直接贴进周报或喂给另一个 agent；`--json` 给结构化数据。

```
agentboard summary [--period day|week|month] [--date <date>] [-t, --tool <ids>] [-p, --project <text>]
                   [--prompts] [--json]
```

| 选项 | 作用 |
| --- | --- |
| `--period` | 默认 `day`。`week` 从周日起，`month` 自然月，按本地时区 |
| `--date` | 落在目标区间内的任意日期（默认今天）：`--period week --date 2026-09-01` = 包含 9 月 1 日那一周；也接受 `yesterday`、`7d` |
| `-t` / `-p` | 只统计这些工具 / 项目 |
| `--prompts` | Markdown 里给每个 session 附上第一条提示词 |
| `--json` | 结构化 |

## 示例

```
$ agentboard summary --period week
# Weekly agent activity — 2026-09-06 → 2026-09-12

- Sessions: **10** across **9** tools and **6** projects
- Messages: 96 (29 prompts, 31 tool calls)

## By tool

- Cursor: 2 sessions, 15 messages
- Cline / Roo / Kilo: 1 sessions, 33 messages
- Goose: 1 sessions, 8 messages
…

## By project

- `mobile-app` (/Users/feng/code/mobile-app): 3 sessions · VS Code, Cursor, Goose
- `agentboard` (/Users/feng/code/agentboard): 2 sessions · Kimi, Cline
…

## Sessions

### infra-terraform  <sub>/Users/feng/code/infra-terraform</sub>

- **Continue: Profile the ingestion script; it takes 4** — Continue · 2026-09-06 15:37 · 25m · 2 prompts / 1 tool calls · `continue:1fe5a3cf-abcd-4f01-8345-6789abcdef01`
- **Cursor: Write a weekly summary of the experi** — Cursor · 2026-09-07 09:37 · 14m · 3 prompts / 3 tool calls · `cursor:55946915-abcd-4f01-8345-6789abcdef01`
…
```

每个 session 行末的 key 可以直接拿去 `show`。

```
$ agentboard summary --period week --json | head -20
{
  "range": { "period": "week", "since": "2026-09-06T16:00:00.000Z", "until": "2026-09-13T16:00:00.000Z", "label": "2026-09-06 → 2026-09-12" },
  "totals": { "sessions": 10, "messages": 96, "userMessages": 29, "toolCalls": 31, "projects": 6, "tools": 9 },
  "byTool": [ { "tool": "cursor", "sessionCount": 2, "messageCount": 15, "userMessageCount": 6, "lastActivity": "…" }, … ],
  "byProject": [ … ],
  "sessions": [ …完整的 SessionSummary，含 promptText… ]
}
```

`sessions[]` 是完整记录（带 `promptText`），一周几十个 session 时可能有几十 KB。只要 key 和标题就用 jq 过一下：`agentboard summary --period week --json | jq '.sessions[] | {key, title, userMessageCount}'`。

## 用法

```bash
# 昨天干了什么，带每个会话的第一句话
agentboard summary --period day --date yesterday --prompts

# 上个月某个项目
agentboard summary --period month --date 2026-08-15 -p trader

# cron 周报：先确保索引新鲜，再写文件
agentboard scan --json >/dev/null && agentboard summary --period week --prompts > ~/reports/week-$(date +%G-W%V).md
```

## 让 agent 写周报

`summary` 给的是**数量**和**清单**，不含内容。让另一个 agent 写"这周做了什么、学到什么"的正确顺序：

1. `summary --period week --json` 拿到 session 列表；
2. 对每个 session `show <key>`（大纲，每个约 2–8 KB）看结构与结论；
3. 对值得展开的几轮 `show <key> --turn N -k reply`；
4. 需要证据时 `show <key> --parts --errors` / `-c edit`。

这样 10 个 session 的周报输入量在 50 KB 左右，而不是几 MB。详见 [agent-workflows.md](agent-workflows.md)。
