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
npm run dev           # dashboard on http://localhost:4817
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

## CLI

```bash
npm run cli -- <command>        # or: npm link && agentboard <command>

agentboard sources [--json]                    # detection + strategy matrix
agentboard scan [--tool a,b] [--full] [--json] # incremental index (file fingerprints), --full re-parses everything
agentboard list [--since 7d] [--until 2026-09-01] [--tool cursor,codex] [--project infra] [--search text]
                [--limit 50] [--offset 0] [--asc] [--keys] [--json]
agentboard search timezone error [--since 30d] [--json]
agentboard show <key> [--json] [--summary] [--max-chars 4000]   # transcript as Markdown or JSON
agentboard projects [--since 30d] [--tool ...] [--json]
agentboard tools [--json]
agentboard summary --period day|week|month [--date 2026-09-01] [--tool ...] [--project ...] [--prompts] [--json]
agentboard import chatgpt|claude-web|markdown <file> [--tool trae] [--project /path] [--title ...]
```

Dates accept ISO, `YYYY-MM-DD`, `today`, `yesterday`, or relative `12h`, `7d`, `2w`, `1m`. Every command has `--json` for machine consumption; `list --json` returns `{ total, items }` and session keys look like `claude-code:<uuid>`. Query commands refresh the index first (incremental, usually milliseconds); pass `--no-auto-scan` to skip that, or `--index <file>` to point at another index.

Example automation — a weekly digest written by a cron job or by another agent:

```bash
agentboard scan --json >/dev/null && agentboard summary --period week --prompts > ~/reports/week-$(date +%G-W%V).md
```

## HTTP API

Served by the dashboard process, same engine and filter grammar:

| Endpoint | Purpose |
| --- | --- |
| `GET /api/sessions?tool=a,b&project=x&q=text&range=7d\|since=..&until=..&page=1&limit=50&order=desc` | paged session summaries |
| `GET /api/sessions/{key}` | summary + full transcript (`?transcript=0` to skip loading it) |
| `GET /api/projects`, `GET /api/tools`, `GET /api/days` | aggregates (same filters); `days` items carry `sessionCount`, `messageCount`, `userMessageCount`, `byTool` |
| `GET /api/heatmap?weeks=52&tool=..&project=..&q=..` | dense per-day series for the heatmap (`userMessageCount` = human turns), zeros included |
| `GET /api/summary?period=week&anchor=2026-09-01&format=json\|md` | period digest |
| `GET /api/sources` | detection / strategy matrix |
| `POST /api/scan` `{ "tools": ["cursor"], "full": false }` | re-index |
| `GET /api/stats` | totals, last scan, endpoint list |

## Configuration

All optional. Each adapter also honours the tool's own environment variable when one exists.

| Variable | Effect |
| --- | --- |
| `AGENTBOARD_HOME` | where the index lives (default `~/.agentboard`) |
| `AGENTBOARD_FAKE_HOME` | treat this directory as `$HOME` (demo data, tests) |
| `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `COPILOT_HOME`, `CURSOR_CONFIG_DIR`, `GROK_HOME`, `PI_SESSIONS_DIR`, `KIMI_CODE_HOME`, `KIMI_HOME`, `DSH_HOME`, `TRAE_TRAJECTORY_DIR`, `AGENTBOARD_TRAE_TRAJECTORY_DIRS`, `WORKBUDDY_DIR`, `CODEBUDDY_DIR`, `MINIMAX_DATA_DIR`, `MAVIS_DATA_DIR`, `ZCODE_DATA_DIR`, `OPENCODE_DB` | override a tool's store location |
| `OPENCODE_SERVER_URL` | read OpenCode through its HTTP API instead of the database |
| `OPENWEBUI_URL`, `OPENWEBUI_API_KEY` | enable the Open WebUI adapter |
| `VSCODE_USER_DIRS` | extra VS Code `User` folders (path-delimited) |
| `AGENTBOARD_TRAE_USER_DIRS` | extra Trae `User` folders containing `workspaceStorage/` (path-delimited) |

## How it works

```
src/engine/
  types.ts            normalized model: SessionSummary / SessionDetail / Message, SourceAdapter, Strategy
  adapters/*.ts       one adapter per tool: detect() → scan() → load()
  webchat/            ChatGPT / Claude.ai export parsers, Open WebUI API, reserved BrowserChatProvider
  index/store.ts      SQLite index (~/.agentboard/index.db): summaries, prompts for search, scan state
  indexer.ts          runs adapters, skips unchanged files by (mtime, size), reconciles deleted sources
  summary.ts          day/week/month digests + Markdown rendering
  engine.ts           the facade both the CLI and the API routes call
src/cli/              commander-based CLI
src/app/              Next.js dashboard + /api routes
scripts/demo-data.ts  synthetic fixtures for every format
```

Only session summaries are stored in the index; transcripts are re-read from the tool's own store when you open a session, so the index stays small and never diverges from the source of truth. Locked SQLite databases (an IDE that is running) are copied to a temp file before reading.

## Development

```bash
npm run typecheck && npm run lint
npm test              # node:test; every adapter scans the demo dataset in a throwaway $HOME
npm run test:update   # rewrite tests/adapters.snapshot.json after an intentional parser change
npm run demo && AGENTBOARD_FAKE_HOME=/tmp/agentboard-demo-home npm run cli -- scan
```

`tests/adapters.test.ts` runs each adapter against the synthetic stores from `scripts/demo-data.ts` and checks four things per tool: `detect()` finds the fixture, `scan()` yields well-formed sessions (title, user prompt, time bounds, `seen` list, unique keys), the normalized result matches `tests/adapters.snapshot.json`, and `load()` round-trips every session back to the same transcript. It also asserts that no source session is claimed by two tools (the Copilot family shares one store). `tests/trae-vscdb.test.ts` and `tests/copilot-classify.test.ts` cover the reverse-engineered Trae layout and the Copilot host attribution with hand-written fixtures.

Adding a tool means one file in `src/engine/adapters/` implementing `SourceAdapter`, a `ToolId` in `types.ts`, an entry in `tool-meta.ts` and `registry.ts`, a fixture block in `scripts/demo-data.ts`, then `npm run test:update` to record its snapshot.
