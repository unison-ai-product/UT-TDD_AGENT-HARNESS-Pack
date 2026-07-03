# Changelog

Notable changes to the UT-TDD Agent Harness Pack. Release artifacts
(tarball + sha256 checksum + manifest) are published on the Pack repository
releases page. Signature artifacts remain an external signing boundary and
are marked `signatureCreated=false` in each manifest.

## Unreleased

### Added

- Update-check advisory: `ut-tdd status` compares the harness checkout version
  against the newest release tag on `origin` (24h cache, fail-open) and prints
  an `update:` line when a newer release exists. `--json` gains an additive
  `update` field. The CLI `--version` now reads the real package version.
- Setup guide (`docs/reference/setup-guide.md`): install, projection into an
  existing project, verification checklist, version update, troubleshooting.
  The version-update section documents both notification paths (GitHub
  Watch → Custom → Releases, and the `ut-tdd status` advisory line).

### Fixed

- README: quick start now begins from `git clone`, the status badge reflects
  the public MIT distribution, the wrapper resolution order includes the
  repo-local CLI stage, and two command reference errors are corrected
  (`skill suggest --plan` takes a PLAN id; Codex launches as
  `codex exec -m <model> -`).

## v0.1.4 - 2026-07-03

### Fixed

- Generated consumer CI gates on `doctor --setup-smoke` instead of the full
  self-application doctor, so a fresh consumer pipeline is green from its
  first commit (A-172 C-1).
- Doctor hook gates (`project-hook` / `codex-hook-adapter`) accept the
  wrapper wiring that `ut-tdd setup` generates; gate requirements and setup
  output now share a single definition source (A-172 C-2).
- The `.ut-tdd/bin/ut-tdd.mjs` wrapper resolves the repo-local CLI, so CI
  runners work without the setup machine's absolute path.
- `ut-tdd setup` no longer blocks on the overwrite prompt in non-interactive
  shells; existing files are preserved by default.
- `ut-tdd distribution package` builds the tarball with GNU tar as well as
  bsdtar (relative archive path).
- `package.json` version now tracks the release line.

### Added

- Toolchain pin check joined the pack test gate (`test` / `test:pack`).
- This changelog, distributed with the Pack.

### Removed

- Superseded v1.1 concept documents (`ai-dev-team-*_v1.1.md`) are no longer
  distributed.

## v0.1.3 - 2026-07-01

- Pack-specific CI workflow (supersedes v0.1.2).

## v0.1.2 - 2026-07-01

- Distribution boundary cleanup: excludes source-only docs (adr / design /
  test-design / plans), runtime state, DB files, and legacy skill sources;
  skill content lives under root `skills/`.

## v0.1.1 - 2026-07-01

- Fixed distributed adapter subagent model metadata so consumer agent-guard
  hooks allow shipped roster entries (supersedes v0.1.0 for consumer hook
  smoke).

## v0.1.0 - 2026-07-01

- Initial clean Pack release. Verified fresh clone + `setup --solo` +
  `doctor --setup-smoke`.
