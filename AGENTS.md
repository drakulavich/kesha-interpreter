# AGENTS.md

## Purpose

This repository is a Bun + TypeScript CLI for low-latency Arabic-to-English
speech translation against NVIDIA Riva. Most changes are in one of four areas:

- CLI wiring in `src/index.ts`
- runtime/session orchestration in `src/modes.ts`
- gRPC/proto integration in `src/riva.ts` and `protos/`
- audio/VAD behavior in `src/audio.ts` and `src/vad.ts`

Keep changes narrow and behavior-focused. This project is small, so avoid
adding framework-style abstraction unless tests or duplication clearly justify
it.

## Setup

- Install dependencies with `bun install`
- Typecheck with `bunx tsc --noEmit`
- Run the fast test suite with `bun run test`
- Run the live Riva integration check with `bun run test:riva:e2e`

Useful environment variables:

- `RIVA_ENDPOINT`
- `RIVA_TLS`
- `RIVA_API_KEY`
- `RIVA_VOICE`

The live integration test is intentionally opt-in via `RUN_RIVA_E2E=1`.

## Code Guidelines

- Prefer small, direct TypeScript changes over large refactors.
- Preserve the existing CLI behavior unless the task explicitly changes it.
- When touching `src/modes.ts`, keep the controller seams testable.
- When touching `src/vad.ts`, preserve frame-based deterministic behavior.
- When touching `src/riva.ts` or `protos/`, verify proto imports still resolve
  locally before assuming the live server is at fault.
- Do not introduce native audio dependencies unless explicitly requested. The
  current audio path is based on `sox` subprocesses.

## Testing Expectations

- Add or update tests for behavior changes.
- For VAD changes, add focused tests in `tests/vad.test.ts`.
- For session/mode lifecycle changes, add focused tests in `tests/modes.test.ts`.
- For config or environment handling changes, add tests in `tests/config.test.ts`.
- Use the live Riva E2E only for connection/proto integration checks, not for
  brittle full audio assertions.

## Operational Notes

- The repo may be worked on in an already-dirty tree. Do not revert unrelated
  user changes.
- Keep `README.md`, CLI flags, and actual runtime defaults aligned when you
  change the user-facing contract.
- If a change depends on a real Riva server, say clearly what was verified
  locally and what still depends on external infrastructure.
