# Changelog

All notable changes to `@keyset/cli` are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
The CLI is versioned 0.x: a minor release may change a command; see "Stability" in the README.

## [0.2.1] - 2026-11-18

### Changed

- Published through npm trusted publishing from [keysethq/keyset-js](https://github.com/keysethq/keyset-js), with
  provenance and without a token. The code is the same as 0.2.0. `keyset login` against `https://api.keyset.cloud`
  pairs since the same day; that was a server setting, not a CLI change.

## [0.2.0] - 2026-11-18

First public candidate.

### Added

- MIT licence, `CHANGELOG.md` and a README that starts from `npm install -g @keyset/cli`.
- A pack check in the Keyset repository that installs the packed CLI into a project outside the repository and runs
  `keyset --help`.

### Changed

- `keyset listen` accepts event types newer than the CLI and forwards them unchanged; `trigger` and
  `--events` still name the eight types the CLI knows.

### Changed

- `license` is `MIT` (it was `UNLICENSED` while the package was private).

## [0.1.0]

Internal, never published: `login` with browser pairing, `logout`, `status`, `listen` with signed forwarding to a local
endpoint, `trigger` for sample events with test keys, `events list` and `events resend`, `get` for any `/v1/` path and
shell completion.
