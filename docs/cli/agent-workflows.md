# 给 agent 的工作流配方

这些是另一个 agent（或你自己在终端里）用 `agentboard` 回顾历史时的固定套路。共同原则：**先窄后宽**——先用便宜的命令（列表、聚合、大纲）圈定范围，再对确有价值的位置花预算读原文。每条命令后面标了典型输出量。

## 0. 三层结构

| 层 | 命令 | 每次输出 | 回答什么 |
| --- | --- | --- | --- |
| 定位 | `list` `search` `grep --by-session` `files` `summary` | 1–10 KB | 哪些 session / 文件 / 时间段相关 |
| 结构 | `show <key>`（大纲）`show --parts …` | 2–8 KB | 这个 session 分几步、哪步出错、改了什么 |
| 原文 | `show --turn N` `--seq a:b` `-k …` `-c …` | 受 `--budget` 约束，默认 ≤24k 字符 | 具体说了什么、跑了什么、输出是什么 |

只有第三层会花大量 token，而且每次都有上限和续读指引。

## 1. "上周我在项目 X 上做了什么"

```bash
agentboard list -p X --since 7d                          # 1 KB：有哪些 session
agentboard list -p X --since 7d --keys | while read k; do
  agentboard show "$k" --no-auto-scan | head -20         # 每个 2–8 KB：轮次、工具类别、错误、文件
done
agentboard files -p X --since 7d -n 20                   # 1–3 KB：热点文件
```

要写成文字总结，再对每个 session 取"用户要了什么 + agent 最后说了什么"：

```bash
agentboard show "$k" -k prompt                            # 通常 <2 KB
agentboard show "$k" -k reply --max-chars 500 --budget 8000
```

## 2. "我之前是怎么解决 Y 这个问题的"

```bash
agentboard grep "Y" --by-session --since 3m               # 哪些 session 提到过，出现在 prompt 还是 tool_result
agentboard grep "Y" -k prompt -n 10                       # 我当时是怎么问的
agentboard grep "Y" -k reply -n 10                        # agent 当时怎么回答
```

命中行的 `turn/seq` 直接跳转：

```bash
agentboard show <key> --turn <turn> --max-chars 800       # 那一轮完整过程
agentboard show <key> --seq <seq>                         # 只看那一个 part
```

`--by-session` 的 `kinds` 列很重要：只在 `context` 里命中说明是 AGENTS.md 之类提到了这个词，不是真的做过。

## 3. "哪些命令 / 操作失败过，为什么"

```bash
agentboard grep "" --errors --since 1m --by-session       # 哪些 session 有失败的工具结果
agentboard show <key> --parts --errors                    # 一行一个失败，带 seq、退出码、大小
agentboard show <key> --seq <seq-2>:<seq+1> --max-chars 1500   # 失败前的命令、失败输出、agent 的下一步
```

按类别缩小：`-c shell --errors`（命令失败）、`-c edit --errors`（编辑失败，例如 "string not found"）。

## 4. "这个文件的改动历史"

```bash
agentboard files --file src/auth/middleware.ts --json | jq '.[0].sessionKeys'
agentboard grep "" -c edit --file src/auth/middleware.ts --asc     # 按时间正序的每次编辑
agentboard show <key> --file src/auth/middleware.ts                # 某个 session 里对它的所有调用与结果
```

## 5. "把一个长 session 总结成几段"

对 1500 条消息的 session，不要 `--full`。顺序：

```bash
agentboard show <key>                                    # 大纲：N 轮，每轮的 prompt → 最后回复
agentboard show <key> -k prompt                          # 用户的全部诉求（几百字）
agentboard show <key> -k reply --max-chars 600 --budget 20000    # 每轮结论
agentboard show <key> -k compaction,event                # 有没有压缩 / 中断（说明 agent 丢过上下文）
agentboard show <key> --files                            # 产出落在哪些文件
```

需要引用证据时再 `--turn N` 或 `--seq a:b`。四五条命令合计 20–40 KB，覆盖一个原文 1 MB 的会话。

## 6. "agent 是怎么思考的"（借鉴 / 复盘）

```bash
agentboard show <key> --parts -k reasoning               # 哪几处有 thinking
agentboard show <key> -k reasoning --max-chars 1500      # 读它
agentboard show <key> -k plan                            # 它的 todo / 计划怎么演化
agentboard show <key> -k subagent                        # 有没有派子 agent，子 session 是谁（→ 再 show 它）
```

只有 `rich` 保真度的来源（Codex、Claude Code、Cursor、dsh）有 reasoning；`show` 头部会标出。

## 7. "跨工具对比同一件事"

```bash
agentboard search "Dockerfile multi-stage"               # 不同工具里做过同一任务的 session
agentboard show <cursor-key> -c shell -k tool_call       # Cursor 跑了哪些命令
agentboard show <codex-key>  -c shell -k tool_call       # Codex 跑了哪些命令
```

`category` 让不同 agent 的工具名（`run_terminal_command_v2` vs `exec_command` vs `Bash`）落到同一个筛子里。

## 8. 周报 / 日报自动化

```bash
agentboard scan --json >/dev/null
agentboard summary --period week --json > /tmp/week.json
jq -r '.sessions[] | .key' /tmp/week.json | while read k; do
  agentboard show "$k" --no-auto-scan --json | jq -c '{key, title, turns: .outline.turns | map({turn, prompt: .prompt[:120], reply: .reply[:200], errors})}'
done
```

得到每个 session 的按轮摘要 JSON，交给写作模型即可，输入量与 session 数线性、每个 1–3 KB。

## 9. 机器消费时的注意点

- 所有命令加 `--json`；`list` / `search` 的 JSON 默认精简，只有确实需要 `promptText` 才加 `--full`。
- 参数错误退出码是 2 并有明确错误信息；找不到 session 是 1。不要吞掉 stderr 就假设成功。
- `show` 的 dump 达到 `--budget` 时，最后一行给出精确的续读命令（`--seq a:b`），照抄即可继续。
- 在循环里加 `--no-auto-scan`：一次 `scan` 就够，不必每条命令都刷。
- key 支持唯一前缀，但在脚本里用完整 key 更稳。
