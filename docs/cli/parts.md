# Part 模型：检索的基本单元

`grep` 和 `show` 不是在"消息"上工作，而是在 **part** 上。一个 session 被拆成一串有类型的 part，每个 part 知道自己是谁产生的、是什么、属于第几轮；工具调用还带一个跨 agent 统一的类别。这套词汇借自 DeepSeek Harness 的会话日志（事件 → `message.source` → 内容块），但对所有 37 个来源生效。

## kind：这是什么

| kind | 含义 | 来源举例 |
| --- | --- | --- |
| `prompt` | 人说的话。**每个 prompt 开一个新 turn** | 用户输入 |
| `context` | harness / IDE 注入进模型上下文、但不是人打的文本。带 `form` 细分 | AGENTS.md、`<timestamp>`、`<system_notification>`、附件、系统提示 |
| `reasoning` | 模型的思考 / thinking，来源保留时才有 | Claude Code thinking、Cursor thinking、dsh reasoning、Codex reasoning summary |
| `reply` | 助手可见的回复文本 | |
| `tool_call` | 工具调用，含**完整参数**、`category`、抽出的 `command` 和 `files` | Bash、edit_file_v2、apply_patch… |
| `tool_result` | 工具输出，通过 callId 回链到调用；`isError` / `exitCode` 已知时带上 | |
| `plan` | 计划 / todo 更新 | TodoWrite、update_plan、todo/write |
| `subagent` | 派生 / 等待子 agent；能定位时 `child` 指向子 session 的 key | Task、spawn_agent、subagent/descriptor |
| `compaction` | 上下文压缩后替代历史的摘要 | Codex `compacted`、Claude Code summary、dsh compaction/summary |
| `event` | 值得保留的日志项：中断、审批、模式切换、goal 变更 | turn_aborted、approval/decided |

`context` 的 `form`：

| form | 内容 |
| --- | --- |
| `instructions` | AGENTS.md / CLAUDE.md / rules / skills 目录 / 权限说明 |
| `snapshot` | 环境快照：cwd、git 状态、时间戳、打开的文件、终端状态 |
| `notice` | 通知：后台任务完成、上一轮被中断 |
| `attachment` | 用户附带的文件 / 图片 / 选中代码 |
| `recall` | 跨 session 引用、记忆、"本会话从上一会话继续" |
| `system` | 系统提示词本体 |

这层分类是标题和 `firstPrompt` 干净的原因：`<recommended_plugins>…</recommended_plugins>` 之类不再被当成"用户说的第一句话"。

## category：工具调用做了什么

不同 agent 对同一件事的工具名五花八门（`Bash` / `exec_command` / `run_terminal_command_v2` / `shell`）。`category` 把它们归到一个词汇表，`grep -c` 和 `show -c` 按它过滤：

| category | 覆盖的工具名（节选） |
| --- | --- |
| `shell` | Bash, shell, exec_command, run_terminal_command_v2, local_shell, execute_command, write_stdin |
| `read` | Read, read_file_v2, cat, view, list_dir, read_lints, glob_file_search |
| `edit` | Edit, Write, apply_patch, edit_file_v2, str_replace_based_edit_tool, delete_file, notebook_edit |
| `search` | Grep, Glob, codebase_search, ripgrep_raw_search, semantic_search |
| `web` | web_search, WebFetch, fetch, browse |
| `subagent` | Task, task_v2, spawn_agent, wait_agent, close_agent, job_* |
| `plan` | TodoWrite, update_plan, exit_plan_mode |
| `ask` | ask_question, AskUserQuestion, ask_followup_question |
| `browser` | browser_*, playwright*, computer_use |
| `mcp` | `mcp__*`、`user-*`、`plugin-*` 等前缀 |
| `other` | 以上都不是 |

名字认不出时再看参数：有 `command` 就是 shell，有 `url` 就是 web，有 `old_string`/`content` 就是 edit……

`tool_call` 还会抽出：

- `command`：shell 调用的命令行（`cmd` / `command` / `action.command[]` 各种写法都认）
- `files`：`path` / `file_path` / `target_file` 等字段，以及 apply_patch 的 `*** Update File:` 头、`diff --git` 头。相对路径按 session 的项目根解析成绝对路径，所以 `draft/X.md` 和 `/repo/draft/X.md` 是同一个文件

## turn：按人的一次提问分段

`seq` 是 part 在 session 内的序号（从 0 起），`turn` 是它所属的轮次：遇到一个 `prompt` 就 +1；第一个 prompt 之前的东西（系统提示、注入的指令）是 turn 0。`show` 默认输出就是每轮一行。

## 两种保真度

`show` 头部的 `Parts: 12 (rich)` 里的括号说明这个 session 的 parts 是怎么来的：

- **rich**：adapter 直接从原始存储产出 parts。目前是 Codex、Claude Code、Cursor、DeepSeek Harness。拿得到 reasoning、完整参数、工具输出、退出码、压缩记录。
- **derived**：其余 adapter 只产出扁平消息，parts 由消息派生。有 prompt / reply / tool_call（参数只有 160 字摘要）/ tool_result，没有 reasoning，注入上下文靠文本模式识别。

`derived` 的来源要升级到 rich，只需要把该 adapter 的解析函数改成往 `PartList` 里 push（参考 `src/engine/adapters/codex.ts`）。

## 存储

parts 存在索引里（`parts` 表 + FTS5 trigram 全文索引 `parts_fts`）。`scan` 增量维护；升级后第一次 `scan` 会为已有 session 回填。工具输出每条最多存 16k 字符，其余类型完整保留。本机 300 个 session 约 2 万个 part、100 MB。
