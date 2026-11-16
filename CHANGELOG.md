# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-11-23

### Added

- Initial Pi package — 28 `surfbird_*` tools: tabs, navigation, semantic
  snapshot/ax, click/double_click/fill/type/press_key/scroll, wait
  (incl. networkidle/stable), evaluate, extract, find, links
  (dedupe=url|base), screenshot (viewport/clip/element/fullPage), pdf,
  console, network, webmcp, raw CDP, status+capabilities.
- Per-session browser isolation keyed on `ctx.sessionManager.getSessionId()`;
  `session_shutdown` disposes the registry (pi rebuilds the extension
  instance per session switch).
- Screenshots inline as `image` content parts (≤8 MiB; larger captures
  return the saved path only); PDFs return the saved path.
- `/surfbird-settings` command — interactive settings editor
  (select/input/confirm) writing `~/.pi/agent/surfbird.json`, with live
  `/json/version` probe and paste/import token flow.
- Config: `~/.pi/agent/surfbird.json` (global) + `.pi/surfbird.json`
  (trusted project) merged > env (`SURFBIRD_URL`/`SURFBIRD_ENDPOINT`/
  `KITESURF_URL`/`KITESURF_ENDPOINT`, `SURFBIRD_TOKEN`/`KITESURF_TOKEN`) >
  defaults; machine-bound `surfbird-v1:` encrypted tokenFile.
- Bundled `surfbird-control` skill via the package `skills/` dir.
- Shared host-independent `src/cdp/` core + `find.ts`/`links.ts`/
  `tokenfile.ts`/`token-store.ts`/`schema.ts` kept identical with
  `dsh-control-surfbird-for-kitesurf` and
  `opencode-control-surfbird-for-kitesurf`.
