# `agentboard show`

看一个 session。默认**不**输出全文，而是按轮（turn）的大纲；然后用 `--turn` / `--seq` / `--parts` / `-k` / `-c` 等下钻到需要的 part。任何 dump 都有两道上限：单 part 的 `--max-chars` 和总量 `--budget`，超出时告诉你在哪停下、如何接着看。

```
agentboard show <key>                                   # 大纲
agentboard show <key> --turn <n|a:b>                    # 某几轮的全部 part
agentboard show <key> --seq <n|a:b>                     # 按序号取 part（a: 表示到末尾）
agentboard show <key> --parts [过滤器]                   # 一行一个 part 的表格
agentboard show <key> [过滤器]                           # 直接 dump 匹配过滤器的 part
agentboard show <key> --full                            # 全部 part（仍受 --budget 约束）
agentboard show <key> --files | --summary | --json
```

过滤器：`-k, --kind <kinds>` `-c, --category <cats>` `--tool-name <name>` `--file <text>` `--grep <text>` `--errors`（含义见 [grep.md](grep.md)）。

尺寸：`--max-chars 2000`（每个 part 正文上限）、`--budget 24000`（整次输出上限，单位是字符）。

`<key>` 可以是唯一前缀。`show` 不触发自动扫描。

## 1. 大纲（默认）

```
$ agentboard show claude-code:32e1e853
# Why does the nightly job fail with a timezone error? Investigate and fix

- Tool: Claude Code (cli) · Project: /Users/example/code/infra-terraform
- Time: 2026-09-06 22:37 → 2026-09-06 22:51 (14m) · Model: claude-opus-5 · Branch: main
- Key: `claude-code:32e1e853-abcd-4f01-8345-6789abcdef01` · Source: file /Users/example/.claude/projects/-Users-example-code-infra-terraform/32e1e853-abcd-4f01-8345-6789abcdef01.jsonl
- Parts: 12 (rich) · Turns: 3 · Tool calls: 3 (edit 1, shell 1, search 1) · Errors: 0 · Files: 1

## Turns

turn  at     dur  seq   calls    err  prompt                                                                     → last reply
────  ─────  ───  ────  ───────  ───  ─────────────────────────────────────────────────────────────────────────  ──────────────────────────────────────────
1     22:37  2m   0-3   1 (ed1)       Why does the nightly job fail with a timezone error? Investigate and fix   The job reads `date.today()` in local time but compares against UTC timestamps from the d…
2     22:43  2m   4-7   1 (sh1)       Refactor the auth middleware to use the new session store                  Done. The middleware now pulls sessions from `SessionStore`, the old cookie parsing is re…
3     22:49  2m   8-11  1 (se1)       Write a weekly summary of the experiments in results/ as a markdown table  Here is the summary table. Three runs improved BLEU by 0.4-0.9; the run with the larger b…

## Files (1)

edits  reads  path
─────  ─────  ─────────────────────────────────────────────
1      2      /Users/example/code/infra-terraform/src/index.ts

Tools: Edit ×1, Bash ×1, Grep ×1

Next: `show claude-code:32e1e853-… --turn N` · `--seq a:b` · `--parts [--kind reply,prompt] [--category shell] [--grep text] [--errors]` · `--json`
```

头部的 `Parts: 12 (rich)`：part 数与保真度（`rich` = adapter 原生产出；`derived` = 从扁平消息派生，见 [parts.md](parts.md)）。`Errors` 是失败的工具结果数；有 reasoning、注入上下文、压缩时会多出对应计数。

Turns 表每行一轮：开始时刻、时长、part 序号区间、工具调用数及按类别缩写（`sh` shell / `ed` edit / `rd` read / `se` search / `web` / `sub` subagent / `plan` / `ask` / `br` browser / `mcp`）、错误数、用户提问、该轮**最后一段**助手回复。一个 1500 条消息的真实 Codex session 在这个视图下是 8 KB。

这个视图回答的是：这个会话分几步、每步做了什么类型的事、哪一步出了错、改了哪些文件。要看具体内容才进入下面几种模式。

## 2. 按轮下钻：`--turn`

```
$ agentboard show claude-code:32e1e853 --turn 1 --max-chars 300
# Why does the nightly job fail with a timezone error? Investigate and fix

- Tool: Claude Code (cli) · Project: /Users/example/code/infra-terraform
- Time: 2026-09-06 22:37 → 2026-09-06 22:51 (14m) · Model: claude-opus-5 · Branch: main
- Key: `claude-code:32e1e853-abcd-4f01-8345-6789abcdef01` · Source: file …

### [0] t1 prompt · 22:37
Why does the nightly job fail with a timezone error? Investigate and fix

### [1] t1 tool_call edit `Edit` · claude-opus-5 · 22:38
files: /Users/example/code/infra-terraform/src/index.ts
```
file_path: /Users/example/code/infra-terraform/src/index.ts
```

### [2] t1 tool_result edit `Edit` (19B) · 22:38
```
export const x = 1;
```

### [3] t1 reply · claude-opus-5 · 22:39
The job reads `date.today()` in local time but compares against UTC timestamps from the database. I switched both to `datetime.now(timezone.utc)` and added a regression test that runs with `TZ=Asia/Shanghai`.
```

每个 part 的标题行：`[seq] t<turn> <kind> [(form)] [<category> \`<tool>\`] [(ERROR, exit N, 大小)] [→ child] [· model] [· 时刻]`。shell 调用的正文渲染成 `$ <command>`；reasoning 和 context 用引用块；工具输出和调用参数用代码块。

`--turn 3:5` 取多轮；`--turn 0` 是第一个提问之前的注入内容（系统提示、AGENTS.md）。

## 3. 按序号：`--seq`

`grep` 的每条命中都带 seq，直接跳过去：

```bash
agentboard show codex:019f3d8f --seq 1072            # 一个 part
agentboard show codex:019f3d8f --seq 1068:1075       # 一段
agentboard show codex:019f3d8f --seq 1253:           # 从 1253 到末尾（配合 budget 续读）
```

某个 part 被 `--max-chars` 截断时，尾部会给出精确的续读命令：`…(3930 more chars; \`--seq 913 --max-chars 4331\` for all)`。

## 4. 表格视图：`--parts`

不 dump 正文，一行一个 part，用于扫结构或找序号：

```
$ agentboard show claude-code:32e1e853 --parts
seq  turn  kind         cat     tool  at     size  preview
───  ────  ───────────  ──────  ────  ─────  ────  ────────────────────────────────────────────────────────────────────────────
0    1     prompt                     22:37  72B   Why does the nightly job fail with a timezone error? Investigate and fix
1    1     tool_call    edit    Edit  22:38  56B   /Users/example/code/infra-terraform/src/index.ts
2    1     tool_result  edit    Edit  22:38  19B   export const x = 1;
3    1     reply                      22:39  208B  The job reads `date.today()` in local time but compares against UTC timestamps…
4    2     prompt                     22:43  57B   Refactor the auth middleware to use the new session store
…

12 parts · dump with `show claude-code:32e1e853-… --seq a:b`
```

`size` 列带状态：`1.4K ERR exit 2`。与过滤器组合最有用：

```bash
agentboard show <key> --parts --errors            # 所有失败的工具结果，一行一个
agentboard show <key> --parts -c edit             # 所有文件编辑
agentboard show <key> --parts -k reasoning        # 模型的思考在哪几处
agentboard show <key> --parts --grep "TypeError"  # 正文里含该词的 part
```

## 5. 按类型 dump：`-k` / `-c` / `--tool-name` / `--file` / `--grep` / `--errors`

不带 `--parts` 时，过滤器直接 dump 匹配的 part 正文：

```
$ agentboard show claude-code:32e1e853 -k prompt
…
### [0] t1 prompt · 22:37
Why does the nightly job fail with a timezone error? Investigate and fix

### [4] t2 prompt · 22:43
Refactor the auth middleware to use the new session store

### [8] t3 prompt · 22:49
Write a weekly summary of the experiments in results/ as a markdown table
```

这是"用户到底要了什么"的最省视图——真实的 1500 条消息 session 只有 372 字符。其他常用组合：

```bash
agentboard show <key> -k reply --max-chars 600        # 每轮助手说了什么（简短版）
agentboard show <key> -k reasoning                    # 模型怎么想的
agentboard show <key> -k context                      # 注入了什么（AGENTS.md、通知、附件）
agentboard show <key> -c shell                        # 跑过的所有命令（含输出）
agentboard show <key> -c shell -k tool_call           # 只要命令本身
agentboard show <key> --errors --max-chars 800        # 失败的输出
agentboard show <key> --file src/auth                 # 涉及某文件的调用与结果
agentboard show <key> -k compaction,event             # 压缩点、中断、审批
```

过滤器可以与 `--turn` / `--seq` 叠加：`--turn 11 -c shell --errors`。

## 6. 预算：`--budget` 与 `--max-chars`

- `--max-chars N`：每个 part 正文最多 N 字符，超出截断并给出续读命令。默认 2000。
- `--budget N`：整次输出最多 N 字符。达到后停止，输出类似：

  ```
  … budget of 23.4K reached before seq 1253; 171 part(s) remain. Continue: `show codex:019f3d8f-… --seq 1253:1423` (raise --budget / lower --max-chars to fit more)
  ```

  默认 24000。想一次看更多就加 `--budget 60000`；想在同样预算内多看几个 part 就降 `--max-chars 300`。

`--full` 是"全部 part"的快捷方式，仍然受预算约束——它只是把过滤器全打开，不会一次吐出 1 MB。

## 7. 其他视图

| 选项 | 输出 |
| --- | --- |
| `--summary` | 只有头部元信息（含源文件路径）；`--json` 时是精简记录 + `source` + `children` |
| `--files` | 该 session 触达的文件表（edits / reads / 最后时间） |
| `--json`（大纲模式） | `{ …精简记录, fidelity, children, outline: { partCount, turns[], byKind, byCategory, toolNames, files[], errors } }`；每轮的 prompt/reply 截到 500 字、files 20 个、commands 10 条 |
| `--json`（dump / parts 模式） | `{ key, total, parts[] }`，每个 part 正文按 `--max-chars` 截断（`--full` 不截） |

底部的 `Subagents / forks:` 列出以该 session 为父的子 session key，`show` 它们即可。

## 从 1500 条消息里取一个答案的典型路径

```bash
agentboard show codex:019f3d8f                          # 8 KB：16 轮，哪轮错误最多、改了哪些文件
agentboard show codex:019f3d8f --parts --errors         # 2 KB：29 个失败结果各一行，带 seq
agentboard show codex:019f3d8f --seq 1068:1075          # 5 KB：出错前后的命令与输出
agentboard show codex:019f3d8f --turn 11 -k reply       # 那一轮 agent 的结论
```

四步合计约 20 KB，而以前一条 `show` 是 971 KB。
