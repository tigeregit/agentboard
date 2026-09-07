# `agentboard projects` / `agentboard tools`

两个聚合视图，回答"我的时间花在哪个项目 / 哪个工具上"。都接受与 `list` 相同的过滤器。

```
agentboard projects [-t <ids>] [-p <text>] [--since <date>] [--until <date>] [--surface <kind>] [--json]
agentboard tools    [-t <ids>] [-p <text>] [--since <date>] [--until <date>] [--surface <kind>] [--json]
```

## `projects`

按项目路径分组：session 数、消息数、最后活动、涉及的工具、路径。按最后活动降序。

```
$ agentboard projects --since 30d
project             sessions  msgs  last activity     tools                                              path
──────────────────  ────────  ────  ────────────────  ─────────────────────────────────────────────────  ────────────────────────────────────────────
mobile-app          26        268   2026-09-07 23:50  Copilot app,VS Code,OpenCode,Codex,Cursor,Grok,…   /Users/example/code/mobile-app
agentboard          22        210   2026-09-07 20:57  Copilot app,VS Code,OpenCode,Codex,Cursor,Grok,…   /Users/example/code/agentboard
paper-reproduction  25        265   2026-09-07 18:57  Copilot CLI,Copilot app,VS Code,OpenCode,Codex,…   /Users/example/research/paper-reproduction
infra-terraform     24        246   2026-09-07 17:51  Copilot CLI,VS Code,OpenCode,Codex,Cursor,Grok,…   /Users/example/code/infra-terraform
```

`--json` 每项：`{ path, name, sessionCount, messageCount, userMessageCount, tools[], firstActivity, lastActivity }`。

项目路径来自各工具记录的 cwd；同一个仓库在不同工具里可能是不同写法（符号链接、尾部斜杠），会显示为两行。`-p` 用子串匹配可以把它们一起选中。

## `tools`

按工具分组：session 数、消息数、最后活动。按 session 数降序。

```
$ agentboard tools
id                tool                sessions  msgs  last activity
────────────────  ──────────────────  ────────  ────  ────────────────
cursor            Cursor              8         66    2026-09-07 23:37
claude-code       Claude Code         6         75    2026-09-06 22:51
codex             Codex               5         64    2026-08-31 23:51
antigravity       Antigravity         4         27    2026-09-07 22:43
cline             Cline / Roo / Kilo  4         111   2026-09-07 17:56
…
```

`--json` 每项：`{ tool, sessionCount, messageCount, userMessageCount, lastActivity }`。

## 与 `sources` 的区别

`tools` 只列**有 session 的**工具及其活动量；`sources` 列全部 37 个支持的工具及检测状态、读取策略、告警。前者看使用分布，后者查为什么没数据。

## 用法

```bash
# 本月各项目用了哪些工具
agentboard projects --since 1m

# 只看 IDE 里的活动
agentboard tools --surface ide

# 摘要报告里的"按项目"段落就是这个数据；要自定义格式用 --json + jq
agentboard projects --since 7d --json | jq -r '.[] | "\(.name)\t\(.sessionCount)\t\(.tools|join(","))"'
```
