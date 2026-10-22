# dsh-session-shift

English | [中文](README.md)

A DSH plugin that **hands the current work off to a fresh session** once context pressure reaches a threshold.

Long sessions degrade near the end (author's own observation: "thinking but not outputting" starts around
70% context). DSH's built-in compaction compresses *in place* — it replaces the original history with a
summary. This plugin takes the other road: **open a new session and carry over a reviewable handoff
package**, leaving the old session untouched.

- Triggered by **real context pressure**, or by **how many times this session has been compacted** — not a guessed turn count
- The package is **extracted mechanically from the session itself** (files it touched, tools it used, the
  last few user and assistant messages, where the last message stopped) and written to disk for review
- `handoff_now` tool in the desktop app (with a `dryRun` mode) / HTTP endpoints for `dsh web` and the CLI
- Once the new session exists, **the UI switches to it by itself** (via the harness's `uiWorkspace.openSession`; web and desktop)
- The old session is **only renamed with ` [已交接]`** — never archived, never deleted

## How is this different from the similarly named plugins?

Several other plugins carry a similar name (`dsh-session-handoff` and friends). Pick by what you want:

| | Trigger | What gets handed over | Old session |
|---|---|---|---|
| **This plugin** | **Automatic**: context pressure hits the threshold, or the session has been compacted the maximum number of times (default 2) | **The original text, extracted mechanically** — files touched / tools used / last few messages / where it stopped. **No model involved** | Only renamed with ` [已交接]`; text untouched |
| `WeiYe6/dsh-session-handoff` | Manual `/handoff` | **Model-generated** summary | New session with the summary injected |
| `snow-The/dsh-session-handoff` | Manual export / resume | Structured handoff doc + context pruning | — |

In one line: **want it to change shifts on its own with a verbatim package — use this one; want manual
triggering plus a model summary — use those.**

## Permissions and safety

Once installed, this is everything it does:

- Registers one tool, `handoff_now` (with a `dryRun` mode), plus two HTTP endpoints
  (`GET /api/handoff/status`, `POST /api/handoff/run`)
- At the threshold it **creates a new session automatically** and renames the current one with
  ` [已交接]` (**never deletes, never archives, never rewrites the text**)
- Writes files locally only: the project's `.dsh/handoff/` and `$DSH_HOME/handoff-client-report.json`
- **No network calls, nothing sent anywhere, no credential access**

Two things static scanners tend to misread, spelled out:

- `cordis.patch.yml` is a **DSH profile config manifest** (it declares this plugin as one bundle row), **not
  runtime code patching** — there is no monkey-patching anywhere in `lib/` or `client/`
- `new Function` appears only in `selfcheck.mjs` (the self-test, which runs the client code against a fake
  `window` to check the logic) — **the runtime never uses it**

## Requirements

- Developed and verified on DSH desktop **0.2.0-rc.2**
- Automatic switching relies on the harness's `uiWorkspace.openSession`; **older harnesses without that API
  neither switch nor error** — the reason is written to `$DSH_HOME/handoff-client-report.json` (see
  "Known limitations")
- No separate Node install is needed — it uses the runtime bundled with DSH

## Install

### Desktop app (profile `desktop`)

```cmd
"<DSH install dir>\resources\runtime\cli\bin\dsh.cmd" plugin --profile desktop add dsh-session-shift
```

- `desktop` is the profile reserved for Electron, so **only the desktop app's own bundled command can
  manage it**. An npm-installed CLI refuses outright:
  `error: profile "desktop" is managed exclusively by the Electron application`
- **Open the desktop app once first** (that initializes the profile), then **fully quit it** before
  running the command — the profile has a write lock and will otherwise wait
- The desktop `$DSH_HOME` defaults to `%USERPROFILE%\.dsh`, so the profile lives at
  `%USERPROFILE%\.dsh\profiles\desktop`

### `dsh web` (profile `web`)

```bash
dsh plugin --profile web add github:easerlee/dsh-session-shift
```

- The `web` profile **initializes itself on first use** — no manual setup; it lives at
  `$DSH_HOME/profiles/web`
- If your web install uses its own home (its launcher sets `DSH_HOME`), use **that install's**
  `dsh`/`dsh.cmd`, otherwise the package lands in a different home

### Both sides

Then **restart the side you installed into** — the bundle list is read once at startup. Also:

- **Install from GitHub**: `add github:easerlee/dsh-session-shift`. Updates ship through GitHub releases
  only — the npm publishing path is retired
- npm stays at `0.2.5` and gets no new versions; `add dsh-session-shift` installs exactly that
- The command writes the package into the profile's `dependencies` *and* `dsh.profile.bundles`, so no
  manual file editing is needed

Check it is live (web / CLI):

```bash
curl "http://127.0.0.1:<port>/api/handoff/status"
# {"ok":true,...,"tool":"registered"}   ← "registered" means the handoff_now tool is registered too
```

## Uninstall

```cmd
:: desktop — same as install: fully quit the desktop app first, then use its own bundled command
"<DSH install dir>\resources\runtime\cli\bin\dsh.cmd" plugin --profile desktop remove dsh-session-shift
```

```bash
# dsh web
dsh plugin --profile web remove dsh-session-shift
```

You can also just **turn it off** instead: set `enabled` to `false` in the profile's `cordis.patch.yml` —
the plugin stays installed but stops handing off automatically (the `handoff_now` tool and the HTTP
endpoints keep working).

Restart that side afterwards, too. Uninstalling does not touch packages you already generated — files
under `.dsh/handoff/` stay until you delete them.

## Usage

### Desktop: the `handoff_now` tool (recommended)

> You: "hand this off and start a fresh session"
> Agent: calls `handoff_now` → returns the new session id / title / package path

To review the package first without creating a session:

```
handoff_now(dryRun: true)     # writes the package only — no new session, no rename
```

### `dsh web` / CLI: HTTP endpoints

```bash
# trigger manually (omit sessionId to use the most recent active session)
curl -X POST http://127.0.0.1:<port>/api/handoff/run \
  -H "content-type: application/json" \
  -d '{"reason":"manual switch"}'

# status and last result
curl http://127.0.0.1:<port>/api/handoff/status
```

On `dsh web`, the `?token=` in the address bar is the credential (visit `/` once so the cookie is set —
API calls are rejected before that). The desktop app has no address bar; trigger it with the tool above.

### Automatic

**A session is handed off automatically only once.** It fires when `cooldownMs` has elapsed and either
condition holds:

- pressure has reached `thresholdRatio`
- **this session has been compacted `maxCompactions` times** (default 2)

The second one matters: compaction always pushes pressure back below its own threshold, so a
pressure-only trigger never gets its chance. How the two get along is below.

"Only once" matters too: a handoff **does not clear the old session's context**, so once the condition
holds it holds forever (the compaction count only grows). With nothing but `cooldownMs` in the way, an old
session handed off again every 5 minutes and opened a fresh session each time — ending with several
sessions all doing the same work. A session that has been handed off is remembered (in memory, plus the
`[已交接]` marker in its title, so it survives a DSH restart). To let it hand off again, remove
`[已交接]` from the title; `handoff_now` is always available manually.

### What happens when a handoff actually fires (in this order)

1. **The package is written to disk first** (`.dsh/handoff/`) — nothing else is touched until that succeeded, so no work is lost
2. **The new session's title**: `原标题（接 N）`, where N is **the highest number in the old title + 1**; legacy `（接 02-15）`-style time suffixes are replaced by the number, and you never get stacked parentheses. The runtime also auto-titles sessions from their content (which overwrites ours), so the plugin writes its title back once before the new session's first turn ends and then leaves it alone — **your own rename is never taken back**
3. **The old session**: its title gets ` [已交接]`, and **its running turn is stopped** (see `stopOldSession`). Without that stop it keeps working while the new session works from the same package, and both edit the same files. **Exception: if that turn has only just started (within `liveGraceMs`, 60s by default) it is left alone** — that means someone just spoke and is waiting for an answer, and stopping it would swallow the question

## Configuration

In the profile's `cordis.patch.yml`:

```yaml
- id: dsh-session-shift
  config:
    enabled: true
    thresholdRatio: 0.85     # shipped default is 0.6; raise it when running with compaction
    maxCompactions: 2        # hand off after this many compactions of the session (0 = pressure only)
    cooldownMs: 300000
    handoffDir: .dsh/handoff
    recentMessages: 14
    maxChars: 24000
    renameOldSuffix: " [已交接]"
    dryRun: false
```

| Key | Default | Description |
|---|---|---|
| `enabled` | `true` | When off, only the HTTP endpoints and the tool remain, no automatic handoff |
| `thresholdRatio` | `0.6` | Pressure ratio that triggers a handoff (0.6 = 60%); raise it when running alongside compaction, see below |
| `maxCompactions` | `2` | Hand off after this many compactions of the session (`0` = pressure only) |
| `cooldownMs` | `300000` | Minimum gap between two handoffs of the same session (auto handoff is once per session anyway; this mainly throttles `dryRun` previews) |
| `handoffDir` | `.dsh/handoff` | Where packages are written (relative to the workspace; absolute works too) |
| `recentMessages` | `14` | How many user messages the user-message section carries (each clipped to 400 chars) |
| `maxChars` | `24000` | Character cap for the package; the remainder is budgeted to the two message windows, and the older ones are dropped first |
| `renameOldSuffix` | ` [已交接]` | Suffix appended to the old session's title |
| `dryRun` | `false` | **true = write the package only, create no session** (useful for a first check) |
| `stopOldSession` | `true` | After a handoff, **stop the old session's running turn** (via the harness's `workspace/session-stop`, the same path as the UI's stop button; nothing is archived or deleted). Set `false` to let the old session keep running |
| `liveGraceMs` | `60000` | Skip that stop when the old session's current turn **started less than this long ago** (ms): someone most likely just spoke and is waiting for an answer, and stopping would swallow the question. Long-running turns are still stopped |

⚠️ A patch `config` **replaces the whole block** — when overriding, repeat every key you don't want to change.

The assistant-message section has no count setting of its own: it takes whatever budget is left after the
user-message section and fills it **from the newest backwards**, each message capped at 600 chars. When the
budget runs out, the *older* messages are the ones dropped; the newest is always there (it is the
"where it stopped" anchor).

## What the package contains

The file on disk is Markdown with four sections, all **extracted mechanically** from the session — no
model involved:

| Section | Content |
|---|---|
| Files it touched | Paths this session modified (up to 120) |
| Tools used (count) | Top 12 tools by call count |
| Recent messages | A user-message section plus an assistant-message section, each filled newest-first within its budget; older ones are dropped first |
| Where it stopped | The last assistant message (clipped to 2000 chars) — where the successor picks up |

## Relationship to compaction

With both enabled, the thresholds differ:

| | Threshold | Behaviour |
|---|---|---|
| `compaction-basic` | `0.6` (default) | Compress in place, the session keeps going |
| `dsh-session-shift` | `0.85` (suggested, above compaction) | Open a new session and hand off |

The shipped default is `0.6` as well, the same as compaction's. With both enabled, compaction always
pushes pressure back below its own threshold first, so **a pressure-only trigger never gets its chance**.
The handoff therefore also watches the compaction count: once this session has been compacted
`maxCompactions` times (2 by default) it hands off — compaction handles the daily grind, and enough
compaction means it is time to move on.

Want handoff to be the main mechanism (pressure only, no compaction count)? Set `compaction-basic` back
to `disabled: true`, set `maxCompactions` to `0`, and keep `thresholdRatio` at the shipped default `0.6`.

## Known limitations

1. **Automatic switching needs a navigation API from the harness** — it uses `uiWorkspace.openSession`;
   when that API is absent (older harnesses) it neither switches nor errors, and
   `$DSH_HOME/handoff-client-report.json` records the reason
2. **The package is a mechanical extract of the original text, not a model summary** — four sections: the
   files touched, the tools used (with counts), the last few user/assistant messages, and where it
   stopped. The decisions are in those assistant messages, verbatim, but *which* of them matters is for
   the successor to judge
3. The old session is renamed, not archived (intentional)
4. The HTTP endpoints only act on sessions **live in that host process**: a freshly started instance with
   no session opened yet answers `没有可用会话（session 缺失）`
5. **The ecosystem has several near-named plugins**: `WeiYe6/dsh-session-handoff` (manual `/handoff`,
   model-generated summary), `snow-The/dsh-session-handoff` (structured handoff doc + context pruning)
   and others — see "How is this different from the similarly named plugins?" above

## License

MIT
