# pi-control-surfbird-for-kitesurf

[English](README.md) · [中文](i18n/README.zh-CN.md)

A [Pi](https://pi.dev/) package that gives an AI agent full control of a [Kitesurf](https://github.com/cloudflare/kitesurf) browser engine over the Chrome DevTools Protocol (CDP) — like a human operating a browser. Works with the self-hosted [surfbird](https://github.com/terry2010/surfbird) distribution (raw or token-auth mode) and upstream Kitesurf deployments. Exposes **28 `surfbird_*` tools**: tab management, navigation, semantic accessibility snapshots, click/type/fill, waits, JavaScript evaluation, screenshots, PDF export, console/network inspection, WebMCP, and a raw CDP escape hatch — with one isolated browser per agent session.

Sibling projects: [`dsh-control-surfbird-for-kitesurf`](https://github.com/terry2010/dsh-control-surfbird-for-kitesurf) (DSH) and [`opencode-control-surfbird-for-kitesurf`](https://github.com/terry2010/opencode-control-surfbird-for-kitesurf) (OpenCode) — same tools, other agent harnesses. All three share the host-independent `src/cdp/` core.

## Requirements

- [Pi](https://pi.dev/) coding agent (`@earendil-works/pi-coding-agent`, extensions API)
- Node.js >= 22.19
- A Kitesurf-compatible CDP endpoint — e.g. a surfbird container (`auth` or `raw` mode) or upstream `kitesurf`

## Install

```bash
pi install npm:pi-control-surfbird-for-kitesurf
```

Or try it for one session without installing:

```bash
pi -e npm:pi-control-surfbird-for-kitesurf
# or a local checkout:
pi -e /path/to/pi-control-surfbird-for-kitesurf
```

## Configuration

Precedence: `.pi/surfbird.json` (trusted project) > `~/.pi/agent/surfbird.json` (global) > environment > defaults.

**Easiest:** run `/surfbird-settings` inside pi — an interactive editor (endpoint, token file, session limits, timeouts, screenshot dir, debug log) with a live `/json/version` probe and paste/import-token actions.

Or write `~/.pi/agent/surfbird.json` directly:

```json
{
  "endpoint": "http://127.0.0.1:8080",
  "tokenFile": "~/.pi/agent/surfbird-token",
  "requestTimeoutMs": 120000,
  "keepaliveMs": 300000,
  "maxSessions": 8,
  "idleEvictMs": 300000,
  "screenshotDir": "",
  "debugLog": false
}
```

| Option | Default | Meaning |
|---|---|---|
| `endpoint` | `http://127.0.0.1:8080` | CDP HTTP base or full `ws(s)://` URL. Env: `SURFBIRD_URL` → `SURFBIRD_ENDPOINT` → `KITESURF_URL` → `KITESURF_ENDPOINT` |
| `tokenFile` | — | Token file path — plaintext or `surfbird-v1:` machine-bound ciphertext. Empty falls back to `token`/env |
| `token` | — | Bearer token (env `SURFBIRD_TOKEN`/`KITESURF_TOKEN` also works) |
| `requestTimeoutMs` | `120000` | Per-CDP-call timeout (min 1000) |
| `keepaliveMs` | `300000` | WS keepalive interval (min 30000; engine kills at 10 min idle) |
| `maxSessions` | `8` | Concurrent session browsers; excess evicts idle sessions only (min 1) |
| `idleEvictMs` | `300000` | Min idle duration before a session may be evicted (min 60000) |
| `screenshotDir` | `$TMPDIR/surfbird` | Screenshot/PDF output directory |
| `debugLog` | `false` | Append diagnostics to `~/.pi/agent/surfbird-debug.log` |

**Token encryption:** `/surfbird-settings` → "Paste token…"/"Import token file…" writes a `surfbird-v1:` file encrypted with a key derived from the machine UUID (macOS `IOPlatformUUID`, Linux `machine-id`), AES-256-GCM, mode `0600`. The ciphertext is useless on other machines. Token plaintext is never written to `surfbird.json`.

## The 28 tools

| Tool | What it does |
|---|---|
| `surfbird_status` | Engine probe: product/version, tabs, session stats, config source (never echoes token) |
| `surfbird_tabs` | List/create/select/close tabs (`action=list` default) |
| `surfbird_navigate` | Load a URL; `back`/`forward`/`reload` are separate tools |
| `surfbird_back` / `surfbird_forward` / `surfbird_reload` | History navigation |
| `surfbird_snapshot` | Bounded semantic digest: `[eN]` interactive refs, headings, text blocks |
| `surfbird_ax` | Raw accessibility tree for the current tab |
| `surfbird_click` / `surfbird_double_click` | Click by ref/selector/coords, with optional modifiers |
| `surfbird_fill` | Set control value (Kitesurf `setControlValue`, React/Vue-safe) |
| `surfbird_type` | Type text into a field (key events) |
| `surfbird_press_key` | Named key + modifiers (enter/tab/escape/arrows…) |
| `surfbird_scroll` | Scroll page/element by amount or to target |
| `surfbird_wait` | Predicate waits: load/domcontentloaded/url/text/visible/hidden/enabled/networkidle/stable |
| `surfbird_evaluate` | `Runtime.evaluate` in page context |
| `surfbird_extract` | Article→Markdown via Readability + Turndown |
| `surfbird_find` | Ctrl+F semantics: count/next/prev/clear, context snippets |
| `surfbird_links` | All page links `{url,text}`, dedupe `url`/`base`, selector scope |
| `surfbird_screenshot` | Viewport / `clip` rect / `target`+padding element / `fullPage` — inline image + saved path |
| `surfbird_pdf` | `Page.printToPDF` — saved path |
| `surfbird_console` | Console messages + exceptions, `since` cursor, error filter |
| `surfbird_network` | Request log, `since` cursor, `action=body` for response bodies |
| `surfbird_webmcp` | List/invoke/cancel page-declared WebMCP tools |
| `surfbird_cdp` | Raw CDP escape hatch |

Full usage patterns (observe → act → verify, refs and docTokens, WebMCP, limits) live in the bundled skill: `skills/surfbird-control/SKILL.md`.

## Engine limits (upstream Kitesurf, not this plugin)

- Boa JS + DOM shim, not V8/Chromium — no JS dialogs, no file upload/download, no clipboard, no drag/touch, incomplete `KeyboardEvent`, partial hit-testing
- One WS connection = one isolated browser; disconnect destroys all its tabs
- 60-minute WS hard cap; 10-minute idle timeout (keepalive must stay below it)
- `fullPage` screenshots are emulated by temporary viewport resize, capped ~1440px

## Development

```bash
npm install
npm run check     # tsc --noEmit
npm test          # unit tests (no engine needed)
npm run test:live # live smoke — needs SURFBIRD_URL/TOKEN or a tunnel to a real engine
```

`src/cdp/` is the shared host-independent core — it must not import Pi/host packages; changes here must be manually synced to `dsh-control-surfbird-for-kitesurf` and `opencode-control-surfbird-for-kitesurf` (and vice versa).

## License

[Apache-2.0](LICENSE)

## Related projects

- [surfbird](https://github.com/terry2010/surfbird) — self-hosted Docker distribution of Kitesurf with token auth, REST proxy and MCP server
- [dsh-control-surfbird-for-kitesurf](https://github.com/terry2010/dsh-control-surfbird-for-kitesurf) — the same 28 tools for DSH (DeepSeek Harness)
- [opencode-control-surfbird-for-kitesurf](https://github.com/terry2010/opencode-control-surfbird-for-kitesurf) — the same 28 tools for OpenCode (desktop + TUI)
- [Kitesurf](https://github.com/cloudflare/kitesurf) — Cloudflare's experimental browser engine built for AI agents
- [Pi](https://pi.dev/) — the agent harness this package extends
