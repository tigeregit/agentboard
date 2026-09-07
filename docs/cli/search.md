# `agentboard search`

session 级的文本检索：在标题、用户提示词（全部轮次）、项目名、模型名、key 上做子串匹配，返回匹配的 **session 列表**。适合回答"我有哪些会话是关于 X 的"。

要在 transcript 内部找——命令、报错、助手的某句话——用 [`grep`](grep.md)，那是 part 级的。

```
agentboard search <terms...> [-t <ids>] [-p <text>] [--since <date>] [--until <date>] [--surface <kind>]
                             [-n, --limit <n>] [--json [--full]]
```

多个词之间是 **AND**：每个词都得在该 session 的某个字段里出现。大小写不敏感，中文按子串。

## 示例

```
$ agentboard search Dockerfile -n 5
started           tool         project             title                                                     turns/calls  dur  key
────────────────  ───────────  ──────────────────  ────────────────────────────────────────────────────────  ───────────  ───  ────────────────────────────────────────────────────
2026-09-07 23:37  Cursor       mobile-app          Create a Dockerfile with a multi-stage build for the API  3p/3t        <1m  cursor:9faf37c3-abcd-4f01-8345-6789abcdef01
2026-09-07 19:37  VS Code      mobile-app          Create a Dockerfile with a multi-stage build for the API  2p/2t        6m   vscode-copilot:54723a10-abcd-4f01-8345-6789abcdef01
2026-09-07 18:37  ZCode        paper-reproduction  zcode: Implement dark mode for the settings pag           4p/4t        19m  zcode:ses_zcode26
…

5 of 31 shown
```

第三行的标题里没有 Dockerfile——它匹配的是后面某一轮的提示词。想确认命中位置，转到 `grep Dockerfile -k prompt --session zcode:ses_zcode26`。

```
$ agentboard search timezone nightly --since 30d -t claude-code --json
{
  "total": 1,
  "items": [
    {
      "key": "claude-code:32e1e853-abcd-4f01-8345-6789abcdef01",
      "tool": "claude-code",
      "project": "infra-terraform",
      "title": "Why does the nightly job fail with a timezone error? Investigate and fix",
      …
    }
  ]
}
```

## 与 `grep` 的分工

| | `search` | `grep` |
| --- | --- | --- |
| 粒度 | session | part（一条提示 / 一次调用 / 一段输出） |
| 搜索范围 | 标题、用户提示词、项目名、模型名 | 所有 part 的正文 + 文件路径 + 工具名 |
| 返回 | session 列表 | 命中片段 + 所在 session/turn/seq |
| 引擎 | SQL LIKE | FTS5 trigram（≥3 字符）/ LIKE（更短） |
| 用途 | 先圈定候选会话 | 精确定位到某一轮、某个命令、某条报错 |

典型顺序是 `search`（或 `grep --by-session`）圈会话 → `show` 看大纲 → `show --turn N` 下钻。
