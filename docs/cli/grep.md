# `agentboard grep`

在**所有 session 的 transcript 内部**检索。命中单位是 part（见 [parts.md](parts.md)），每条命中给出所在 session、turn/seq、类型和一段带标记的片段。所有过滤器可叠加，所以能问出很具体的问题："过去一个月哪些 shell 命令跑 docker compose 失败了"。

```
agentboard grep <query...>
    [-k, --kind <kinds>] [-c, --category <cats>] [--tool-name <name>] [--file <text>] [--errors] [--role <role>]
    [--session <key>] [-t, --tool <ids>] [-p, --project <text>] [--since <date>] [--until <date>]
    [-n, --limit 20] [--offset 0] [--asc] [--by-session] [--width 140] [--json]
```

## 查询词

- 多个词是 AND；每个 ≥3 字符的词走 FTS5 trigram（子串匹配，CJK 和标识符都行，返回 `snippet()` 片段）；<3 字符的词（如中文双字词 `菜谱`）在同一批行上用 LIKE 补匹配。
- 片段里命中的词用 `⟦ ⟧` 标出。
- 查询词可以为空字符串 `""`，此时只靠过滤器：`grep "" --errors --since 7d` = 最近一周所有失败的工具结果。

## part 级过滤

| 选项 | 作用 |
| --- | --- |
| `-k, --kind prompt,reply` | 只搜这些类型：`prompt` `context` `reasoning` `reply` `tool_call` `tool_result` `plan` `subagent` `compaction` `event` |
| `-c, --category shell,edit` | 只搜这些工具类别：`shell` `read` `edit` `search` `web` `subagent` `plan` `ask` `browser` `mcp` `other` |
| `--tool-name apply_patch` | 精确工具名（agent 自己的叫法，大小写不敏感） |
| `--file src/auth` | 只看触达了路径含该文本的文件的 part |
| `--errors` | 只看 `isError` 的 `tool_result` |
| `--role user` | 按产生者：`user` / `assistant` / `tool` / `system` |

## session 级过滤

`--session <key>`（可用前缀）限定单个 session；`-t` / `-p` / `--since` / `--until` 与 `list` 相同。时间过滤用 part 自己的时间戳，没有时回退到 session 时间。

## 输出

| 选项 | 作用 |
| --- | --- |
| （默认） | 每条命中一行：session、turn/seq、kind/category、时间、片段 |
| `--by-session` | 按 session 聚合：命中数、按 kind 的分布、标题、key。**先用这个看全貌**，再对某个 session 下钻 |
| `--width 140` | 文本模式片段宽度 |
| `-n` / `--offset` / `--asc` | 分页；默认 20 条、最新在前 |
| `--json` | `{ total, hits[] }`，hit 含 `sessionKey, tool, title, project, seq, turn, kind, role, category, toolName, form, isError, timestamp, files, snippet, bytes` |

## 示例

按命中列出：

```
$ agentboard grep pytest -n 6
session                turn/seq  kind             when              snippet
─────────────────────  ────────  ───────────────  ────────────────  ────────────────────
zcode:ses_zcode26      4/11      tool_call/shell  2026-09-07 18:56  command: ⟦pytest⟧ -q
zcode:ses_zcode26      3/8       tool_call/shell  2026-09-07 18:50  command: ⟦pytest⟧ -q
zcode:ses_zcode26      2/5       tool_call/shell  2026-09-07 18:44  command: ⟦pytest⟧ -q
zcode:ses_zcode26      1/2       tool_call/shell  2026-09-07 18:38  command: ⟦pytest⟧ -q
minimax:ses_minimax27  2/5       tool_call/shell  2026-09-06 17:44  command: ⟦pytest⟧ -q
minimax:ses_minimax27  1/2       tool_call/shell  2026-09-06 17:38  command: ⟦pytest⟧ -q

6 of 31 hits (--offset 6 for more, --by-session to aggregate) · open one: `show <session> --seq <seq>` or `--turn <turn>`
```

`turn/seq` 直接对应 `show <session> --turn 4` 或 `show <session> --seq 11`。

按 session 聚合：

```
$ agentboard grep pytest --by-session
hits  tool      project             title                                               kinds        key
────  ────────  ──────────────────  ──────────────────────────────────────────────────  ───────────  ───────────────────────
4     ZCode     paper-reproduction  zcode: Implement dark mode for the settings pag     tool_call:4  zcode:ses_zcode26
2     MiniMax   mobile-app          minimax: Explain the difference between the two K   tool_call:2  minimax:ses_minimax27
3     MiniMax   agentboard          minimax: Bump dependencies and fix the resulting    tool_call:3  minimax:ses_minimax28
…

31 hits in 9 sessions
```

`kinds` 列告诉你这个词是出现在用户的问题里（`prompt`）、agent 的回答里（`reply`）、命令里（`tool_call`）还是输出里（`tool_result`）——这对判断"这个 session 是不是真的在做 X"很关键：只在 `context` 里出现，往往只是 AGENTS.md 提到了它。

组合过滤，JSON 输出：

```
$ agentboard grep "make test" -c shell -k tool_call -n 2 --json
{
  "total": 9,
  "hits": [
    {
      "sessionKey": "deepseek-harness:5b70217a-bcde-4012-8456-789abcdef012",
      "tool": "deepseek-harness",
      "title": "dsh: Write a weekly summary of the expe",
      "project": "infra-terraform",
      "seq": 17,
      "turn": 4,
      "kind": "tool_call",
      "role": "assistant",
      "category": "shell",
      "toolName": "bash",
      "timestamp": "2026-09-06T11:56:05.472Z",
      "snippet": "command: ⟦make⟧ ⟦test⟧",
      "bytes": 18
    },
    …
  ]
}
```

## 常见问法

```bash
# 我在哪些会话里让 agent 处理过 timezone 问题？（只看人说的话）
agentboard grep timezone -k prompt --by-session

# 过去一个月所有失败的 shell 命令
agentboard grep "" -c shell --errors --since 1m

# 谁改过 auth 中间件的文件
agentboard grep "" -c edit --file middleware/auth

# agent 在某个 session 里对某个报错说了什么
agentboard grep "ECONNREFUSED" --session codex:019f3d8f -k reply,tool_result

# 找出所有派生过子 agent 的会话
agentboard grep "" -k subagent --by-session

# 找 Codex 里用 apply_patch 改 README 的地方
agentboard grep README --tool-name apply_patch -t codex
```

## 注意

- 索引里的工具输出每条最多 16k 字符；超长输出的尾部搜不到，但 `show --seq N --max-chars <大数>` 依然读的是索引（同样截断）。要看完整原文，去 `show --summary` 给出的源文件路径。
- `grep` 只读索引，不触发自动扫描以外的源读取；新会话要先被 `scan` 到（查询命令默认会做）。
