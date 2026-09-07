# agentboard CLI 使用指南

`agentboard` 把本机所有 AI 编码 agent（Claude Code、Codex、Cursor、Copilot、Kimi、DeepSeek Harness……共 37 种）的会话历史收进一个索引，并提供一套**面向 agent 调用**的命令行。设计目标只有一个：另一个 agent 可以用它回顾历史 session、做总结和借鉴，而不会被一次命令吐回的海量文本淹没。

本目录每个命令一篇，示例输出都来自项目自带的合成数据集，可以在任何机器上复现：

```bash
npm run demo                                   # 生成 $TMPDIR/agentboard-demo-home
export AGENTBOARD_FAKE_HOME=$TMPDIR/agentboard-demo-home
agentboard scan
```

## 命令索引

| 命令 | 一句话 | 文档 |
| --- | --- | --- |
| `sources` | 支持哪些工具、本机装了哪些、各自怎么读、索引了多少 | [sources.md](sources.md) |
| `scan` | 刷新索引（增量；`--full` 全量） | [scan.md](scan.md) |
| `list` / `ls` | 按时间、工具、项目、文本筛 session，列表 | [list.md](list.md) |
| `search` | session 级检索：标题 / 提示词 / 项目名 | [search.md](search.md) |
| `grep` | **transcript 内部**的跨 session 检索，命中返回片段 | [grep.md](grep.md) |
| `show` | 看一个 session：默认按轮大纲，按需下钻到任意 part | [show.md](show.md) |
| `files` | agent 编辑 / 读取过的文件，跨 session 聚合 | [files.md](files.md) |
| `projects` / `tools` | 按项目、按工具的聚合统计 | [projects-tools.md](projects-tools.md) |
| `summary` | 日 / 周 / 月摘要（Markdown 或 JSON） | [summary.md](summary.md) |
| `import` | 导入 ChatGPT / Claude.ai 导出、任意 Markdown 聊天记录 | [import.md](import.md) |
| `serve` / `server` | Web 看板：前台运行或后台服务 | [server.md](server.md) |

概念性的两篇：

- [parts.md](parts.md) — **part 模型**：session 内容被拆成哪些类型，`grep` / `show` 的过滤器都建立在它之上
- [agent-workflows.md](agent-workflows.md) — 给 agent 的端到端配方：找 → 看结构 → 下钻 → 总结

## 全局约定

### session key

每个 session 由 `<tool>:<nativeId>` 唯一标识，例如 `claude-code:32e1e853-abcd-4f01-8345-6789abcdef01`。凡是接受 `<key>` 的地方都可以给**唯一前缀**：`show claude-code:32e1e853` 或 `show 32e1e853` 都行，匹配到多个时报错。

### 日期

`--since` / `--until` 接受：ISO 时间、`YYYY-MM-DD`、`today`、`yesterday`、相对值 `12h` / `7d` / `2w` / `1m`。`--until` 是开区间上界。无法解析的值直接报错（exit 2），**不会**被静默忽略。

### 输出形态

- 默认是给人和 agent 都能读的对齐表格 / Markdown。
- 每个查询命令都有 `--json`。`list` / `search` 的 JSON 默认是**精简记录**（key、tool、project、title、时间、turns、toolCalls、messages、model），加 `--full` 才带 `promptText` 等重字段。
- `show` 的任何 dump 都受两个上限约束：单个 part 的 `--max-chars`（默认 2000）和整次输出的 `--budget`（默认 24000 字符）。超出时输出在哪里停下、还剩多少、用哪条命令接着看。
- stderr 干净：不会有 Node 的 SQLite 实验性警告混进 `2>&1` 的 JSON。

### 退出码

| 码 | 含义 |
| --- | --- |
| 0 | 成功 |
| 1 | 找不到 session / 源文件无法读取 / 运行时错误 |
| 2 | 参数非法（未知工具、日期解析失败、`-n abc`、未知 kind/category 等） |
| 3 | 仅 `server status`：服务未运行 |

### 索引与刷新

索引在 `~/.agentboard/index.db`（`AGENTBOARD_HOME` 或 `--index <file>` 可改）。查询类命令默认先做一次增量扫描（只重读 mtime/size 变化的文件，通常几毫秒到几百毫秒）；`--no-auto-scan` 或环境变量 `AGENTBOARD_NO_AUTO_SCAN=1` 跳过。`show` / `grep` 走索引里的 parts，不重读源文件。

### 全局选项

```
agentboard [--index <file>] [--no-auto-scan] <command> [options]
agentboard --help | <command> --help
```
