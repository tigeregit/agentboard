# `agentboard import`

把没有本地存储、只能靠官方导出的聊天记录纳入索引：ChatGPT 网页版、Claude.ai 网页版，以及任意 Markdown 格式的聊天导出（Trae、VS Code "Chat: Export Session"、手写笔记）。导入的数据存为 `~/.agentboard/imports/<tool>/<id>.json`，之后与其他来源一样参与 `list` / `grep` / `show`。

```
agentboard import chatgpt    <conversations.json>
agentboard import claude-web <conversations.json>          # 别名 claude
agentboard import markdown   <file.md> [--tool <id>] [--project <path>] [--title <text>]   # 别名 md
```

| 选项（仅 markdown） | 作用 |
| --- | --- |
| `--tool trae` | 归到哪个工具 id 下（默认 `trae`；必须是已知 id，见 `sources`） |
| `--project /path/to/repo` | 归到哪个项目 |
| `--title "…"` | 覆盖标题（默认取第一条用户消息） |

导入完成后会自动对该工具做一次扫描，输出 `indexed under tool "…". Try: agentboard list -t …`。

## ChatGPT

1. ChatGPT → Settings → Data controls → Export data，收到邮件后下载 zip。
2. 解压得到 `conversations.json`。
3. `agentboard import chatgpt ~/Downloads/chatgpt-export/conversations.json`

每个对话成为一个 `chatgpt:<conversation_id>` session；对话树只取当前分支。

## Claude.ai

1. Settings → Privacy → Export data，下载后解压。
2. `agentboard import claude-web ~/Downloads/claude-export/conversations.json`

得到 `claude-web:<uuid>` session。这与 Claude Code（`claude-code:`）是两个来源。

## Markdown

识别 `**User**` / `**Assistant**`、`## User` / `## Assistant`、`> User:` 这几类分段标题。一个文件一个 session。

```bash
# Trae IDE 的聊天导出（Trae 的数据库是加密的，导出是唯一途径）
agentboard import markdown ~/Downloads/trae-chat.md --tool trae --project ~/code/myapp

# VS Code Copilot 的 "Chat: Export Session"
agentboard import md session.md --tool vscode-copilot --title "Refactor auth"
```

## 重复导入

同一个 `nativeId` 再次导入会覆盖之前的 JSON；重新导出一次 ChatGPT 全量数据就是"刷新"。删除某条导入的记录：删掉对应的 `~/.agentboard/imports/<tool>/<id>.json` 再 `agentboard scan -t <tool>`。

## 保真度

导入的会话走 `derived` 路径（见 [parts.md](parts.md)）：有 prompt / reply，网页聊天通常没有工具调用，也没有 reasoning。`grep -k prompt,reply` 对它们完全可用。
