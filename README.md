# agentboard

One board and one CLI over the session history of every AI coding agent on your machine.

Most people now use several agents in parallel: Claude Code for one repo, Cursor for another, Codex in CI, Copilot in VS Code, a handful of Chinese-market CLIs on the side. Each one keeps its own history in its own format. agentboard indexes all of them into a single normalized model so that

- **humans** get a dashboard filtered by time, tool and project, and
- **agents / scripts** get the same engine through a CLI and a JSON API, e.g. to write daily or weekly digests automatically.

## Supported sources

| Tool | How it is read today | Native query interface |
| --- | --- | --- |
| GitHub Copilot CLI | `~/.copilot/session-state/<id>/events.jsonl` + `workspace.yaml` | reserved: sessions sync to GitHub (`/chronicle`) but there is no public REST surface yet |
| GitHub Copilot app (desktop) | same store; sessions are attributed by `workspace.yaml` `host_type`, then `client_name` (`github/cli`, `github/autopilot` = desktop app, `github/vscode`), then the `~/.copilot/data.db` `sessions` table | reserved |
| VS Code Copilot Chat | `User/workspaceStorage/<hash>/chatSessions/*.jsonl` mutation logs (legacy `*.json` too), `globalStorage/emptyWindowChatSessions`, plus VS Code-hosted agent sessions in `~/.copilot` | none; `Chat: Export Session` is manual |
| OpenCode | **`opencode serve` HTTP API** when `OPENCODE_SERVER_URL` is set; otherwise `~/.local/share/opencode/opencode.db` or legacy `storage/*.json` | **implemented** (`GET /session`, `/session/:id/message`) |
| Codex CLI | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` (+ `archived_sessions/`) | reserved: `codex app-server` JSON-RPC `thread/list`, `thread/read` |
| Cursor | IDE `state.vscdb` (`cursorDiskKV` composers + bubbles), CLI `~/.cursor/chats/<md5(cwd)>/<id>/store.db`, fallback `agent-transcripts/*.jsonl` | none |
| Grok Build | `~/.grok/sessions/<cwd>/<id>/updates.jsonl` (ACP updates) + `summary.json` | reserved: `grok sessions list\|search` has an FTS5 index but no machine-readable output |
| Claude Code | `~/.claude/projects/<encoded-cwd>/<session>.jsonl` (+ `subagents/`) | reserved: the Agent SDK resumes but cannot list sessions |
| pi coding agent | `~/.pi/agent/sessions/<cwd>/*.jsonl` tree entries, active branch followed | library-only `SessionManager` |
| Kimi Code / Kimi CLI | **`~/.kimi-code/session_index.jsonl`** to enumerate, then `wire.jsonl` + `state.json`; legacy `~/.kimi/sessions/.../context.jsonl` | **native index implemented** |
| DeepSeek Harness (`dsh`) | `~/.dsh/sessions/<cwd>/session-<id>/session.jsonl(.zstd)`, zstd decoded in-process (torn frames tolerated) | reserved: `dsh web` is UI-only for now |
| Trae | Trae IDE / SOLO chats from `User/workspaceStorage/<hash>/state.vscdb` (`ItemTable` icube mementos: `memento/icube-ai-agent-storage`, `ChatStore`, `icube-ai[-ng]-chat-storage-*`; reverse-engineered, best effort); `trae-agent` CLI `trajectory_*.json`. The IDE's `ModularData/ai-agent/database.db` is SQLCipher-encrypted (detected, not readable) — for anything missing use the in-app export + `agentboard import markdown --tool trae` | reserved: SOLO cloud sync has no public API |
| WorkBuddy / CodeBuddy Code | `~/.codebuddy/projects/<cwd>/<session>.jsonl` (flat item schema and Claude-shaped legacy files) | none |
| MiniMax Code (`mcode`) | OpenCode-schema SQLite under `MINIMAX_DATA_DIR` / `~/.minimax` / `~/.local/share/minimax-code`; pre-isolation builds land in OpenCode's DB and are shown there | reserved: ACP |
| ZCode | `~/.zcode/cli/db/db.sqlite` (OpenCode schema) or legacy `~/.zcode/projects/*.jsonl` | reserved: `zcodex app-server` ACP `session/list` |
| Gemini CLI | `~/.gemini/tmp/<projectHash>/chats/session-*.jsonl` (+ legacy `.json`), cwd from `.project_root`; subagent sessions skipped | none |
| Qwen Code | `~/.qwen/projects/<sanitized-cwd>/chats/<id>.jsonl` (`QWEN_RUNTIME_DIR`, `QWEN_HOME`) | none |
| Antigravity | CLI: `~/.gemini/antigravity-cli/history.jsonl` + `brain/<id>/.system_generated/logs/transcript_full.jsonl`; desktop: `monitor-state.json` + `.token-monitor/rpc-cache` usage records (conversation `.pb` / `.db` blobs are detected, not decoded) | none |
| Amazon Q CLI / Kiro CLI | `<data_local_dir>/amazon-q/data.sqlite3` `conversations`, `<data_local_dir>/kiro-cli/data.sqlite3` `conversations_v2` (v1 fallback) | none |
| Aider | `<project>/.aider.chat.history.md`, sessions split on `# aider chat started at …`; projects found one level under `~/{code,src,projects,…}` or `AGENTBOARD_AIDER_DIRS` | none |
| Cline / Roo Code / Kilo Code | `<host>/User/globalStorage/<extension>/tasks/<id>/ui_messages.json` for VS Code, Insiders, VSCodium, Cursor, Windsurf; task index from `taskHistory.json`, `_index.json` or `state.vscdb` | none |
| Continue / PearAI | `~/.continue/sessions/<id>.json` (`CONTINUE_GLOBAL_DIR`), `~/.pearai/sessions/` | none |
| Crush | `<project>/.crush/crush.db` (depth-4 discovery under the same project roots, `AGENTBOARD_CRUSH_DIRS`) | none |
| ForgeCode | `~/.forge/.forge.db` `conversations` (`FORGE_CONFIG`), both context serialisations | none |
| Goose | `sessions.db` under `~/.local/share/goose`, `~/Library/Application Support/Block/goose`, `GOOSE_PATH_ROOT` | none |
| llm CLI | `io.datasette.llm/logs.db` `conversations` + `responses` (`LLM_USER_PATH`) | none |
| oh-my-pi | `~/.omp/agent/sessions/<cwd>/*.jsonl` (pi format) | none |
| OpenHands | `~/.openhands/sessions/<sid>/events/*.json` + `metadata.json` | reserved: app-server REST |
| Open Interpreter | `~/.openinterpreter/sessions/**/rollout-*.jsonl` (Codex format, shared parser) | none |
| Mistral Vibe | `~/.vibe/logs/session/<dir>/meta.json` + `messages.jsonl` (`VIBE_HOME`) | none |
| Zed (Agent Panel) | `threads/threads.db` (JSON or zstd blobs) under the Zed data dir | none |
| ChatGPT (web) | official data export: `agentboard import chatgpt conversations.json` | consumer API: none (Compliance API is enterprise-only) |
| Claude.ai (web) | official data export: `agentboard import claude-web conversations.json` | none |
| Open WebUI | **REST API** (`OPENWEBUI_URL` + `OPENWEBUI_API_KEY`) | **implemented** |

Every adapter declares its strategies in order of preference (`api` → `native-index` → `sqlite`/`file` → `import`) with a status of `implemented`, `reserved` or `unavailable`. `agentboard sources --json` and the **Sources** page print this matrix for the current machine, so when a vendor ships a query API the adapter can switch to it without changing the data model.

Browser-based access to web chat boxes (for services without an API) is reserved as an interface only: see `src/engine/webchat/browser.ts` (`BrowserChatProvider`). Nothing is scraped today.

## Quick start

Requires Node 22.13+ (uses the built-in `node:sqlite`).

```bash
npm install
npm run scan          # index every agent found on this machine (~/.agentboard/index.db)
npm run dev           # dashboard on http://localhost:4817 (hot reload, for hacking on the UI)
```

Or run the dashboard from the CLI (the first start builds the production bundle):

```bash
npm link                                    # once; makes `agentboard` available
agentboard serve                            # foreground on http://127.0.0.1:4817, Ctrl-C to stop
agentboard server start                     # same thing as a background service
agentboard server status | stop | restart   # manage it
```

No agents installed? Generate a synthetic home with every supported format:

```bash
npm run demo          # writes /tmp/agentboard-demo-home
npm run dev:demo      # dashboard over the demo data
AGENTBOARD_FAKE_HOME=/tmp/agentboard-demo-home npm run cli -- list --since 7d
```

## Dashboard

- **Sessions** (`/`) — stat cards, a GitHub-style **interactions heatmap** (52 weeks; cell colour = human turns that day summed over all sessions, i.e. how much you talked to agents, not how many sessions you opened; click a cell to narrow the board to that day via `?day=YYYY-MM-DD`), per-day stacked activity chart, filters (search, tool, project, time range) and the session list grouped by day. Filters live in the URL, so any view is linkable.
- **Session detail** (`/sessions/<key>`) — metadata, subagent links, and the full transcript loaded on demand from the tool's own store (user/assistant bubbles, tool calls, collapsible tool output).
- **Projects** (`/projects`) — working directories aggregated across tools with a per-tool breakdown.
- **Reports** (`/summary`) — daily / weekly / monthly digest with a ready-to-paste Markdown block and the equivalent CLI command.
- **Sources** (`/sources`) — what was detected, which strategy is used, probed paths, warnings from the last scan; full rescan button.

The dashboard keeps its own index fresh: every page and API request runs an incremental scan when the last one is older than `AGENTBOARD_AUTO_SCAN_SECONDS` (default 60), and the server process also re-scans on that interval in the background, so new sessions show up without anyone running `agentboard scan`. Incremental scans only re-read files whose size or mtime changed, so this is usually a few milliseconds. The **Rescan** button / `POST /api/scan` remain for forcing a full re-parse.

## CLI

Per-command guides with example output live in [`docs/cli/`](docs/cli/README.md) (start with [agent-workflows.md](docs/cli/agent-workflows.md) if another agent is the caller).

```bash
npm run cli -- <command>        # or: npm link && agentboard <command>

agentboard sources [--json]                    # detection + strategy matrix
agentboard scan [--tool a,b] [--full] [--json] # incremental index (file fingerprints), --full re-parses everything
agentboard list [--since 7d] [--until 2026-09-01] [--tool cursor,codex] [--project infra] [--search text]
                [--limit 50] [--offset 0] [--asc] [--keys] [--json [--full]]
agentboard search timezone error [--since 30d] [--json]          # session level: titles / prompts / project

# inside transcripts (the part index; see "Parts" below)
agentboard grep <query...> [-k prompt,reply,reasoning,tool_call,tool_result,plan,subagent,compaction,context,event]
                [-c shell,edit,read,search,web,subagent,plan,ask,browser,mcp] [--tool-name Bash] [--file path]
                [--errors] [--session <key>] [--role user] [-t ...] [-p ...] [--since ...] [-n 20] [--by-session] [--json]
agentboard show <key>                                          # outline: one row per turn (prompt → last reply, calls by category, errors, files)
agentboard show <key> --turn 3 | --turn 3:5 | --seq 120:140      # dump parts; per-part --max-chars 2000, total --budget 24000 (tells you how to continue)
agentboard show <key> --parts [-k reply] [-c shell] [--errors] [--grep text] [--file x]   # one row per matching part
agentboard show <key> -k prompt                                # e.g. only what the human asked; --full for everything (still budgeted)
agentboard show <key> --files | --summary | --json
agentboard files [--since 30d] [-p proj] [--session key] [--file text] [-n 50]   # files agents edited / read, across sessions
agentboard projects [--since 30d] [--tool ...] [--json]
agentboard tools [--json]
agentboard summary --period day|week|month [--date 2026-09-01] [--tool ...] [--project ...] [--prompts] [--json]
agentboard import chatgpt|claude-web|markdown <file> [--tool trae] [--project /path] [--title ...]

agentboard serve [-p 4817] [-H 127.0.0.1] [--dev] [--build]      # dashboard in the foreground (blocks)
agentboard server start [-p] [-H] [--dev] [--build] [--json]      # dashboard as a background service
agentboard server status [--json]                                 # url, pid, uptime, index state; exit 3 when stopped
agentboard server stop [--json]
agentboard server restart [-p] [-H] [--build] [--json]            # keeps previous port/host unless overridden
```

`serve` and `server start` run the production build (`next start`); they build it on first use or with `--build`, and `--dev` runs `next dev` instead. The background service records its pid, port and URL in `~/.agentboard/server.json` and appends output to `~/.agentboard/server.log`; `stop` sends SIGTERM to the process group and escalates to SIGKILL after 10 s. `AGENTBOARD_PORT` / `AGENTBOARD_HOST` set the defaults; use `-H 0.0.0.0` to expose the board on the LAN.

Dates accept ISO, `YYYY-MM-DD`, `today`, `yesterday`, or relative `12h`, `7d`, `2w`, `1m`; unparsable values are rejected (exit 2) rather than ignored. Every command has `--json` for machine consumption; `list --json` returns `{ total, items }` with compact records (`--full` adds `promptText` etc.) and session keys look like `claude-code:<uuid>`. Query commands refresh the index first (incremental, usually milliseconds); pass `--no-auto-scan` to skip that, or `--index <file>` to point at another index.

### Parts: the retrieval unit

The CLI is meant to be driven by another agent, so nothing should return a whole transcript by accident. Every session is decomposed into typed **parts** (vocabulary borrowed from the DeepSeek Harness session log: who produced it, what kind of thing it is, and for tool traffic a cross-agent category):

| kind | what it is | typical filters |
| --- | --- | --- |
| `prompt` | a human utterance; each one opens a new **turn** | `-k prompt` = "what did I ask" |
| `context` | text the harness/IDE injected (`form`: instructions, snapshot, notice, attachment, recall, system) — never mistaken for a prompt | titles and `firstPrompt` are computed after this split |
| `reasoning` | thinking blocks when the source keeps them (Claude Code, Cursor, dsh, Codex summaries) | |
| `reply` | assistant visible text | outline shows the last reply of each turn |
| `tool_call` | full arguments, `category` (shell / read / edit / search / web / subagent / plan / ask / browser / mcp), extracted `command`, `files` | `-c shell`, `--tool-name apply_patch`, `--file src/x.py` |
| `tool_result` | output linked to its call by id; `isError`, `exitCode` when known | `--errors` |
| `plan`, `subagent`, `compaction`, `event` | todo updates, child agents, context compactions, aborted turns / approvals | |

Parts live in the index (`parts` + FTS5 trigram `parts_fts`, so CJK and identifiers match as substrings and hits come back as snippets). `scan` fills them for changed sessions; a first run after upgrading backfills every session. Codex, Claude Code, Cursor and dsh adapters emit parts natively (`rich`); every other adapter gets them derived from its flat transcript (`derived`), so all 37 tools participate.

Typical agent workflow — "what did I do about X last month, and what went wrong?":

```bash
agentboard grep "docker compose" --since 1m --by-session          # which sessions, how many hits, of which kinds
agentboard show codex:019f3d8f                                    # 8 KB outline of a 1500-message session
agentboard show codex:019f3d8f --parts --errors                   # the failed tool results, one line each
agentboard show codex:019f3d8f --turn 11 --max-chars 600          # the turn that fixed it, budgeted
agentboard files -p trader --since 1m                             # which files were touched
```

Example automation — a weekly digest written by a cron job or by another agent:

```bash
agentboard scan --json >/dev/null && agentboard summary --period week --prompts > ~/reports/week-$(date +%G-W%V).md
```

## HTTP API

Served by the dashboard process, same engine and filter grammar:

| Endpoint | Purpose |
| --- | --- |
| `GET /api/sessions?tool=a,b&project=x&q=text&range=7d\|since=..&until=..&page=1&limit=50&order=desc` | paged session summaries |
| `GET /api/sessions/{key}` | summary + transcript (`?transcript=0` metadata only, `?view=parts` typed parts, `?view=outline` per-turn outline) |
| `GET /api/projects`, `GET /api/tools`, `GET /api/days` | aggregates (same filters); `days` items carry `sessionCount`, `messageCount`, `userMessageCount`, `byTool` |
| `GET /api/heatmap?weeks=52&tool=..&project=..&q=..` | dense per-day series for the heatmap (`userMessageCount` = human turns), zeros included |
| `GET /api/summary?period=week&anchor=2026-09-01&format=json\|md` | period digest |
| `GET /api/sources` | detection / strategy matrix |
| `POST /api/scan` `{ "tools": ["cursor"], "full": false }` | force a re-index now (the board already refreshes itself; use for `full`) |
| `GET /api/stats` | totals, last scan, `scanning`, `autoScanSeconds`, uptime, endpoint list — also the health probe used by `agentboard server status` |

## Configuration

All optional. Each adapter also honours the tool's own environment variable when one exists.

| Variable | Effect |
| --- | --- |
| `AGENTBOARD_HOME` | where the index lives (default `~/.agentboard`) |
| `AGENTBOARD_FAKE_HOME` | treat this directory as `$HOME` (demo data, tests) |
| `AGENTBOARD_AUTO_SCAN_SECONDS` | how stale the index may get before the dashboard re-scans (default `60`, `0` = only on first visit / manual rescan) |
| `AGENTBOARD_PORT`, `AGENTBOARD_HOST` | defaults for `agentboard serve` / `agentboard server start` (`4817`, `127.0.0.1`) |
| `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `COPILOT_HOME`, `CURSOR_CONFIG_DIR`, `GROK_HOME`, `PI_SESSIONS_DIR`, `KIMI_CODE_HOME`, `KIMI_HOME`, `DSH_HOME`, `TRAE_TRAJECTORY_DIR`, `AGENTBOARD_TRAE_TRAJECTORY_DIRS`, `WORKBUDDY_DIR`, `CODEBUDDY_DIR`, `MINIMAX_DATA_DIR`, `MAVIS_DATA_DIR`, `ZCODE_DATA_DIR`, `OPENCODE_DB`, `GEMINI_HOME`, `QWEN_RUNTIME_DIR`, `QWEN_HOME`, `CONTINUE_GLOBAL_DIR`, `FORGE_CONFIG`, `GOOSE_PATH_ROOT`, `LLM_USER_PATH`, `INTERPRETER_HOME`, `VIBE_HOME` | override a tool's store location |
| `AGENTBOARD_AIDER_DIRS`, `AGENTBOARD_CRUSH_DIRS` | extra project roots to search for `.aider.chat.history.md` / `.crush/crush.db` (path-delimited) |
| `OPENCODE_SERVER_URL` | read OpenCode through its HTTP API instead of the database |
| `OPENWEBUI_URL`, `OPENWEBUI_API_KEY` | enable the Open WebUI adapter |
| `VSCODE_USER_DIRS` | extra VS Code `User` folders (path-delimited) |
| `AGENTBOARD_TRAE_USER_DIRS` | extra Trae `User` folders containing `workspaceStorage/` (path-delimited) |

## How it works

```
src/engine/
  types.ts            normalized model: SessionSummary / SessionDetail / Message, SourceAdapter, Strategy
  parts/              Part model: types, injected-context classifier + tool-category mapping, messages⇄parts, turns/outline
  adapters/*.ts       one adapter per tool: detect() → scan() → load(); codex/claude-code/cursor/deepseek-harness emit parts directly
  webchat/            ChatGPT / Claude.ai export parsers, Open WebUI API, reserved BrowserChatProvider
  index/store.ts      SQLite index (~/.agentboard/index.db): summaries, prompts for search, scan state
  index/parts-store.ts  parts + FTS5 (trigram) for cross-session / in-session retrieval, files touched
  indexer.ts          runs adapters, skips unchanged files by (mtime, size), reconciles deleted sources, indexes parts
  summary.ts          day/week/month digests + Markdown rendering
  engine.ts           the facade both the CLI and the API routes call
src/cli/              commander-based CLI
src/app/              Next.js dashboard + /api routes
scripts/demo-data.ts  synthetic fixtures for every format
```

The index holds session summaries plus the typed parts of each transcript (tool output capped at 16k chars per part); the dashboard's transcript view still re-reads the tool's own store when you open a session, so it never diverges from the source of truth. Locked SQLite databases (an IDE that is running) are copied to a temp file before reading.

## Development

```bash
npm run typecheck && npm run lint
npm test              # node:test; every adapter scans the demo dataset in a throwaway $HOME
npm run test:update   # rewrite tests/adapters.snapshot.json after an intentional parser change
npm run demo && AGENTBOARD_FAKE_HOME=/tmp/agentboard-demo-home npm run cli -- scan
```

`tests/adapters.test.ts` runs each adapter against the synthetic stores from `scripts/demo-data.ts` and checks four things per tool: `detect()` finds the fixture, `scan()` yields well-formed sessions (title, user prompt, time bounds, `seen` list, unique keys), the normalized result matches `tests/adapters.snapshot.json`, and `load()` round-trips every session back to the same transcript. It also asserts that no source session is claimed by two tools (the Copilot family shares one store). `tests/trae-vscdb.test.ts` and `tests/copilot-classify.test.ts` cover the reverse-engineered Trae layout and the Copilot host attribution with hand-written fixtures.

Adding a tool means one file in `src/engine/adapters/` implementing `SourceAdapter`, a `ToolId` in `types.ts`, an entry in `tool-meta.ts` and `registry.ts`, a fixture block in `scripts/demo-data.ts`, then `npm run test:update` to record its snapshot.
