# `agentboard serve` / `agentboard server`

Web 看板（Next.js）。`serve` 在前台跑，`server start|stop|status|restart` 把它当后台服务管理。两者与 CLI 共用同一个引擎和索引，看板进程还会每 60 秒自己做增量扫描。

```
agentboard serve          [-p, --port 4817] [-H, --host 127.0.0.1] [--dev] [--build]
agentboard server start   [-p] [-H] [--dev] [--build] [--json]
agentboard server stop    [--json]
agentboard server status  [--json]
agentboard server restart [-p] [-H] [--build] [--json]
```

| 选项 | 作用 |
| --- | --- |
| `-p, --port` | 端口，默认 4817（或 `AGENTBOARD_PORT`） |
| `-H, --host` | 绑定地址，默认 127.0.0.1（或 `AGENTBOARD_HOST`）；`0.0.0.0` 暴露到局域网 |
| `--dev` | 用 `next dev` 代替生产构建（开发看板时用） |
| `--build` | 启动前重新 `next build`；不加时首次启动会自动构建，之后复用 `.next/` |
| `--json` | 机器可读结果 |

## `serve`

前台运行，Ctrl-C 退出。第一次运行会先 `next build`（一两分钟），日志直接打到终端。

```bash
agentboard serve
agentboard serve -p 8080 -H 0.0.0.0        # 局域网访问
agentboard serve --dev                      # 改看板代码时
```

## `server start` / `stop` / `status` / `restart`

后台守护：pid、端口、URL 记在 `~/.agentboard/server.json`，输出追加到 `~/.agentboard/server.log`。

```
$ agentboard server start
started at http://127.0.0.1:4817 (pid 41233, log /Users/feng/.agentboard/server.log)

$ agentboard server status
agentboard server: running
field         value
────────────  ────────────────────────────────────────────
url           http://127.0.0.1:4817
pid           41233
mode          production
started       2026-09-07 23:40
uptime        0h 12m
index         316 sessions · 12 tools · 99 projects
last scan     2026-09-07 23:51
auto-refresh  every 60s
log           /Users/feng/.agentboard/server.log

$ agentboard server stop
stopped pid 41233 (http://127.0.0.1:4817)
```

- `status` 的退出码：0 运行中、3 未运行——脚本里可以直接 `agentboard server status >/dev/null || agentboard server start`。
- `start` 时已在运行会提示 `already running at …`，不会起第二个。
- `stop` 给进程组发 SIGTERM，10 秒未退出升级 SIGKILL。
- `restart` 未显式传的 `-p` / `-H` / `--dev` 沿用上一次的设置。
- 进程不在了但 `server.json` 还在（比如机器重启），`status` 会标注 stale，`start` 会清掉再启动。

## `--json`

```bash
agentboard server status --json
# { "running": true, "stale": false, "pid": 41233, "port": 4817, "host": "127.0.0.1", "url": "…", "startedAt": "…", "dev": false, "log": "…", "health": { "uptimeSeconds": 720, "counts": {…}, "lastScan": "…", "scanning": false, "autoScanSeconds": 60 } }
```

`health` 来自看板的 `GET /api/stats`。

## HTTP API

看板进程同时提供 JSON API，过滤参数与 CLI 同一套语法（`tool=a,b` `project=` `q=` `range=7d` / `since=` `until=`）：

| 端点 | 对应 CLI |
| --- | --- |
| `GET /api/sessions?…&page=1&limit=50` | `list` / `search` |
| `GET /api/sessions/{key}` | `show --full`（扁平消息）；`?view=outline` = `show`；`?view=parts` = parts；`?transcript=0` = `--summary` |
| `GET /api/projects` `GET /api/tools` `GET /api/days` | `projects` / `tools` |
| `GET /api/summary?period=week&anchor=…&format=json\|md` | `summary` |
| `GET /api/sources` | `sources` |
| `POST /api/scan` `{"tools":[…],"full":false}` | `scan` |
| `GET /api/stats` | 健康探针 |

`grep` 和 `files` 目前只有 CLI。

## 环境变量

`AGENTBOARD_PORT` / `AGENTBOARD_HOST` 设默认值；`AGENTBOARD_AUTO_SCAN_SECONDS` 调整看板自动刷新间隔（0 关闭）；`AGENTBOARD_HOME` 决定 `server.json` / `server.log` / 索引的位置。
