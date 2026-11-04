<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/logo/logo-dark.png">
  <img src="docs/logo/logo-light.png" width="112" alt="trove">
</picture>

# trove

### Every conversation is a treasure trove.

**Claude Code, Codex, OpenCode and Doubao sessions — archived losslessly to your own WebDAV or S3 bucket,**<br>
then merged into a personal library that follows you across every device you own.

[![Release](https://img.shields.io/npm/v/trove-cli?label=release&color=111111)](https://www.npmjs.com/package/trove-cli) [![Stars](https://img.shields.io/github/stars/blankPen/trove?style=flat&color=111111)](https://github.com/blankPen/trove/stargazers) [![License](https://img.shields.io/badge/license-MIT-111111)](LICENSE)<br>
![Node.js](https://img.shields.io/badge/Node.js-22%2B-000000?logo=node.js&logoColor=white) ![macOS](https://img.shields.io/badge/macOS-000000?logo=apple&logoColor=white) ![Linux](https://img.shields.io/badge/Linux-FCC624?logo=linux&logoColor=black) ![Windows](https://img.shields.io/badge/Windows-0078D4?logo=windows&logoColor=white)

**English** · [简体中文](README.zh-CN.md)

<br>

</div>

<br>

## Is trove for you?

Every AI coding agent keeps its history somewhere you don't control. Claude Code writes JSONL under `~/.claude/projects`, Codex under `~/.codex/sessions`, OpenCode in a SQLite database, Doubao in a workspace folder. Delete your laptop, reinstall an agent, or switch machines, and it's gone. The raw bytes are there; the *meaning* — what you were working on, what you decided, what you learned — isn't anywhere at all.

trove takes that raw material and turns it into something you keep:

- **Lossless archiving.** The local vault is a byte-for-byte copy of every source file. Nothing is summarised, nothing is dropped, nothing is rewritten on the way in.
- **Your own storage, not someone else's.** WebDAV (Nextcloud, Nutstore, a self-hosted davfs) or any S3-compatible bucket (Aliyun OSS, Tencent COS, MinIO). No account required, no telemetry, no server in the middle.
- **Incremental, and it stays incremental.** A cursor of `{size, mtime, prefix hash}` means an unchanged file is skipped, a grown file transfers only its new bytes, and anything rewritten in place is rebuilt from scratch.
- **Multi-device.** Each device writes only its own files and its own index shard, so two machines can sync without stepping on each other. Pull the other laptop's sessions on your desktop; push the desktop's skills to the laptop.
- **A library, not a dump.** Sessions are merged by `(tool, session id)`, skills are de-duplicated by content hash with every version kept, and the extracted lessons — preferences, projects, debugging patterns — become Markdown you can actually read and grep.
- **Learn from your own history.** An LLM reads the sessions you never got around to reviewing and distills them into 17 kinds of memory: your coding style, the projects you work on, the gotchas you hit, the decisions you made.

It's for you if you've ever lost a conversation, wanted a session on a machine that wasn't there, or wished you could ask "what did I decide about this last month?" If you have a dozen sessions and never look back, you don't need it.

## Quick start

**1 · Install.**

```sh
npm i -g trove-cli      # provides the `trove` command
npx trove-cli --help    # or try it without installing
```

The unscoped `trove` name on npm belongs to another package, so this one publishes as **`trove-cli`**; the command itself is still `trove`. Node.js 22 or newer.

**2 · Point it at a remote.** Run the interactive setup and it will ask what kind of remote you have, then the fields that kind needs:

```sh
trove init
```

Or skip the questions:

```sh
trove init --url https://dav.example.com/ --username u --password p
trove init --type s3 --provider aliyun --region cn-hangzhou \
  --bucket my-bucket --access-key-id AKID --secret-access-key SK --no-daemon
```

**3 · Sync.**

```sh
trove sync --since 7d
```

That's the whole setup. A daemon starts by default and keeps the archive current in the background.

## Supported tools

| Tool | Where it keeps sessions | What gets archived |
|---|---|---|
| **Claude Code** | `~/.claude/projects/**/*.jsonl`, `~/.claude/transcripts/**/*.jsonl` | Both session stores (they don't overlap), plus skills, plans, tasks and `CLAUDE.md` |
| **Codex** | `~/.codex/sessions/**/*.jsonl`, `~/.codex/archived_sessions/**/*.jsonl` | Rollout JSONL plus skills |
| **OpenCode** | `~/.local/share/opencode/opencode.db` | `session_v2`/`session_message` plus the legacy `session`/`message`/`part` tables, exported per session as deterministic JSONL with every column kept |
| **Doubao** (office build) | `~/Library/Application Support/DoubaoWork/.../agent_mode/workspace` | `.sessions/<id>` board/memory/agent traces and `conversation/<id>` |

Credential files (`settings.json`, `auth.json`, `config.toml`, `*.key` and friends) are excluded at the adapter layer and never leave your machine. Any tool can be turned off individually with `trove config set sources.<id>.enabled false`.

## How it fits together

```
your agents                your machine                    your storage
─────────────              ────────────                    ───────────
Claude Code  ─┐
Codex        ─┤        ┌──────────────────┐        ┌──────────────────┐
OpenCode     ─┼──────▶ │  ~/.trove/vault   │ ─────▶ │  WebDAV / S3     │
Doubao       ─┘        │                  │        │                  │
                      │  raw/   devices   │        │  raw/    devices │
                      │  library/ merged  │        │  library/ merged │
                      └──────────────────┘        └──────────────────┘
                                  ▲
                                  │ one cursor, one sync, many devices
```

**raw/ is what the machine saw.** The exact bytes of every source file, laid out per device. It's a fact, not an opinion.

**library/ is what it meant.** Sessions merged across tools and devices into one normalised JSONL stream, skills collected by content hash, a unified index, and the lessons extracted from all of it.

Both travel together. `raw` is the bigger half and you can keep it local if you like — `trove config set sync.raw false` syncs the library only, and `--raw` / `--no-raw` on the command line override that per run.

## What it does

### Lossless, incremental sync

- **A cursor per file** — `{size, mtime, prefix hash, generation}`. Unchanged means skipped; grown means only the new bytes travel; shrunk, rewritten in place, or a mismatched prefix hash means a full rebuild under a new generation.
- **Byte-for-byte on the way in.** The vault holds the original bytes, not a rendering of them. OpenCode is exported from the database with every column of both the current and the legacy schema intact (measured: 782 sessions / 153,406 rows / 990 MB).
- **Blocks on WebDAV, objects on S3.** WebDAV has no multipart upload, so remote files are stored as immutable 4 MiB chunks; S3 gets one object per file, so you can open a session in your bucket console and read the original. Both verify sha256 on pull.
- **Flat chunk paths.** Chunks live at `<device>/chunks/<tool>/`, so a sync doesn't perform a `MKCOL` per file. On S3, large files go through Multipart Upload.
- **Measured**: a second full scan of 2,450 items took 14 s and uploaded 2.

### Multi-device without conflicts

Each device writes only its own files and its own index shard, so nothing is ever overwritten concurrently. When the same session differs between devices, the index picks a canonical version (the event superset) and keeps the others as `variants` — every version is kept, never dropped.

The index itself is a derived artefact: `index/<device>.json` is authoritative, `index.json` is merged locally, and a rebuildable index never means lost data.

### The library layer

```
~/.trove/vault/
├── raw/<device>/<tool>/…            original bytes (device × tool)
└── library/                          your personal assets (synced)
    ├── index.json                    unified index (derived, rebuildable)
    ├── index/<device>.json           per-device index shard (written only by that device)
    ├── sessions/<tool>/<session>/<device>.jsonl
    ├── skills/<name>/versions/<hash>/…   content-addressed, every version kept
    ├── skills/<name>/meta/<device>.json
    └── lessons/                      extracted knowledge (synced)
```

The event schema stays `session / message / reasoning / tool_call / tool_result / meta`, with `raw: {path, line}` pointing back at the original file.

### Lessons — what the sessions actually taught you

This is the part that isn't just backup. trove runs an LLM over sessions you never reviewed and writes the result as Markdown, organised into 17 memory types across 5 categories:

| Category | Types |
|---|---|
| **Preferences** | user profile, coding style, writing style, dialogue style, recent matters |
| **Entities** | projects, people, organizations, tools, tech stack |
| **Experiences** | debug patterns, workflows, gotchas, corrections |
| **Events** | decisions |
| **Resources** | docs, repositories, links |

Each type has its own merge rule, so a re-run updates what it should and appends what it should. Every entry cites the sessions it came from, and `trove learn --list` shows the exact diff of what the extractor added or changed.

```sh
trove learn -n 10              # extract from the 10 most recent unlearned sessions
trove learn --list             # audit the last extraction
trove learn-memo               # pull in Claude Code's own memory files
trove learn-recent             # aggregate your recent direction of work
trove refresh                  # rebuild the layered overview
```

Extraction needs an OpenAI-compatible endpoint, configured once:

```sh
trove config set llm.baseUrl https://api.deepseek.com/v1
trove config set llm.model deepseek-chat
trove config set llm.apiKey sk-…
```

`trove usage` then reports what that costs you, broken down by task and model.

### A daemon that stays out of the way

```sh
trove daemon start --interval 300 --since 7d
trove daemon status
trove daemon restart
trove daemon stop
```

One instance per machine (pid lock), a cross-process sync lock, cooperative shutdown on `SIGTERM`, status written to `~/.trove/daemon.status.json`, rotated logs. The interval, the time window and whether `init` starts it are all config (`config.daemon.{intervalSeconds,since,startOnInit}`, defaulting to `300 / 7d / true`); explicit flags win over config. Any `trove config` write restarts a running daemon so new startup settings take effect. A separate learn loop runs on its own interval (`config.daemon.learnIntervalSeconds`, `learnBatch`).

### Search and overview

```sh
trove status                    # local, remote, daemon, pending
trove sessions --grep refactor  # search titles, summaries, paths, models
trove sessions --harness codex --json
trove skills show review        # every version and origin of one skill
trove library reindex           # rebuild the unified index from device shards
trove usage --since 7d --json
trove whoami                    # profile, preferences, recent direction
trove lessons search "edit button"   # FTS5 over lessons
trove lessons show <path>       # read one lesson
trove sessions search "COS signature" # FTS5 over sessions
trove sessions search "SignatureDoesNotMatch" --exact  # linear grep
trove sessions show <id> --around "SignatureDoesNotMatch"
trove index build               # build/update the session search index
trove status --json             # machine-readable overview
```

`trove status` reports four things: what each tool has archived locally (count and size), whether the remote is reachable (5 s probe, device count, last seen), the daemon's state and last result, and what is still pending — sessions, files and skills by category.

### Knowledge base for agents (skill + MCP)

`trove mcp` exposes seven read-only tools over stdio; `trove skill install` puts the matching skill in `~/.claude/skills` and/or `~/.agents/skills`. The CLI and MCP surfaces are one-to-one:

| MCP tool | CLI | What it returns |
|---|---|---|
| `trove_whoami` | `trove whoami` | Profile, preferences and recent direction |
| `trove_lessons_search` | `trove lessons search` | Lessons: preferences, entities, experiences, decisions |
| `trove_lesson_get` | `trove lessons show` | One lesson, optionally a section or line range |
| `trove_lessons_list` | `trove lessons list` | Browse a lessons category |
| `trove_sessions_search` | `trove sessions search` | Historical sessions; `--exact` for identifiers |
| `trove_session_get` | `trove sessions show` | Events around a match |
| `trove_status` | `trove status --json` | Index and data freshness |

Search is **SQLite FTS5 + BM25** through Node's built-in `node:sqlite`, with CJK 2-gram preprocessing. Lessons use an in-process index (~280 ms cold); sessions use a persistent incremental index at `~/.trove/cache/search.sqlite` (local cache, rebuildable, never synced). Exact identifiers — error codes, function names, paths — fall back to `--exact` linear grep, which covers the tool output the index truncates to 1 KB.

```sh
claude mcp add trove -- trove mcp
trove skill install --target both
```

### Deletion is explicit

Nothing is deleted by default, on either side. A source file you delete stays archived; the only removal path is `trove clean`, which deletes remote objects that no index references and that are older than 24 hours.

```sh
trove clean --dry-run   # list
trove clean             # list, then confirm interactively (default: no)
trove clean --yes       # just do it
```

Safety rules: a missing device index skips that whole device; a single unreadable library shard skips the whole library; `lessons/**`, merged session files and skill metadata are always kept; anything uploaded in the last 24 hours or with no timestamp is never deleted. The daemon never triggers a cleanup on its own.

## Command reference

| Command | What it does |
|---|---|
| `trove init` | First-time setup: device name, remote type, credentials |
| `trove rename <name>` | Rename this device (the id and archived paths stay the same) |
| `trove sync` | Collect local sessions and sync (collect → pull → push) |
| `trove clean` | Remove unreferenced remote objects older than 24 h |
| `trove status` | Overview: local, remote, daemon, pending |
| `trove sessions` | List and search library sessions |
| `trove whoami` | Profile, preferences and recent direction |
| `trove lessons` | `search` / `show` / `list` over extracted lessons |
| `trove sessions search` | FTS5 session search; `--exact` for identifiers |
| `trove sessions show` | Read events around a match |
| `trove index build` | Build/update the session search index |
| `trove mcp` | Start the stdio MCP server |
| `trove skill` | `install` / `uninstall` the trove skill |
| `trove skills` | List merged skills, or `show <name>` for every version |
| `trove library reindex` | Rebuild the unified index from device shards |
| `trove learn` | Extract lessons, or `--list` to audit the last run |
| `trove learn-memo` | Learn from Claude Code's built-in memory files |
| `trove learn-recent` | Aggregate your recent direction of work |
| `trove refresh` | Rebuild the layered lessons overview |
| `trove usage` | Token usage of trove's own LLM calls |
| `trove config` | Interactive config, or `get`/`set`/`path` |
| `trove daemon` | `start`, `restart`, `stop`, `status` |

Useful flags on `trove sync`: `--since 7d|24h|2026-10-01|all` (only sessions changed since then), `--pull-only`, `--push-only`, `--raw` / `--no-raw`, `--quiet`.

## Remote backends

| Backend | How to configure | Notes |
|---|---|---|
| **WebDAV** | `trove init --url … --username … --password …` | The default; works with self-hosted and third-party services |
| **Aliyun OSS** | `--type s3 --provider aliyun --region cn-hangzhou --bucket …` | S3-compatible, virtual-hosted addressing |
| **Tencent COS** | `--type s3 --provider tencent --region ap-guangzhou --bucket …` | S3-compatible; the bucket name needs the `-<appid>` suffix |
| **Any S3-compatible** | `--type s3 --endpoint … --force-path-style --region … --bucket …` | MinIO and other private deployments |

Interactive setup asks for the remote type first, then the fields that type needs.

**Switching backends doesn't lose anything.** Indexes, device metadata and the library layout are identical across backends; only the raw file layout differs. The `remoteId` in `state.json` records which remote the push watermark belongs to — when the backend changes, the old watermark is voided and the history is re-pushed in full, rather than being silently skipped. Run one `trove sync --since all` after switching. Old `chunks/` objects from the previous layout are not removed automatically.

## Local layout

```
~/.trove/
├── config.json              device identity and remote credentials (mode 600)
├── state.json               cursors, push/pull watermarks, library records
├── usage.jsonl              trove's own LLM token usage (append-only, never synced)
├── daemon.pid / daemon.status.json
├── vault/raw/<device>/<tool>/…   archived original bytes
├── vault/library/                personal assets (sessions / skills / index / lessons)
├── tmp/                    temporary files for exports and rebuilds
└── logs/daemon.log
```

Remote layout:

```
raw/<device>/index.json                            index (chunk list and hashes)
raw/<device>/meta.json                             device name / last seen
raw/<device>/chunks/<tool>/<key>.<gen>.<off>-<len>.bin   WebDAV: immutable chunks
raw/<device>/files/<tool>/<relPath>                     S3: whole files
library/index/<device>.json                        per-device index shards
library/sessions/…, library/skills/…               personal assets
```

## Development

```sh
pnpm test          # unit tests + a real WebDAV server + real local session scans
pnpm typecheck
pnpm build
```

## Release

Merging to `main` publishes automatically (`.github/workflows/release.yml`): bump `version` in `package.json` in the PR, and CI installs, builds, tests, publishes to npm, tags `v<version>` and creates the GitHub Release with the npm tarball attached.

One-time npm setup: npmjs.com → your package → Trusted Publisher → GitHub Actions, with `blankPen` / `trove-cli` / `release.yml`, and allow `npm publish`. CI then publishes with OIDC and no long-lived token. With a token instead, add an `NPM_TOKEN` Actions secret (granular, with Read and write (publish and stage) and Bypass 2FA) — a stage-only token only stages the release and needs `npm stage approve <stage-id> --otp <code>` to go live.

Re-running is idempotent: if the version is already on npm, publishing is skipped; if the release already exists, creating it is skipped; if both are done, the whole job is skipped.

## License

[MIT](LICENSE)
