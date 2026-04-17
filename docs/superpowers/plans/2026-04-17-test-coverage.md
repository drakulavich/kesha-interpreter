# Test Coverage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add reliable automated coverage for the VAD pipeline, mode controllers, and an opt-in live-Riva integration path.

**Architecture:** Keep production behavior intact while extracting narrow seams around runtime dependencies so mode logic can be exercised with deterministic fakes. Use `bun:test` for unit and controller tests, and gate the live-Riva integration path behind `RUN_RIVA_E2E=1`.

**Tech Stack:** Bun, TypeScript, `bun:test`, existing gRPC/audio modules

---

### Task 1: Add VAD regression tests

**Files:**
- Create: `tests/vad.test.ts`
- Modify: `src/vad.ts`

- [ ] Write a failing test that proves speech-trigger frames are buffered and emitted when a segment starts.
- [ ] Run `bun test tests/vad.test.ts` and verify it fails for the expected reason.
- [ ] Implement the smallest fix in `src/vad.ts`.
- [ ] Re-run `bun test tests/vad.test.ts` and verify it passes.

### Task 2: Make mode controllers testable

**Files:**
- Create: `tests/modes.test.ts`
- Modify: `src/modes.ts`

- [ ] Write failing controller tests for push-to-talk and live mode lifecycle using fakes.
- [ ] Run `bun test tests/modes.test.ts` and verify the failures are caused by missing seams.
- [ ] Inject narrow dependencies for mic, player, Riva, UI, and process hooks without changing user-visible behavior.
- [ ] Re-run `bun test tests/modes.test.ts` and verify the tests pass.

### Task 3: Add config/CLI coverage and live-Riva integration gate

**Files:**
- Create: `tests/config.test.ts`
- Create: `tests/riva.e2e.test.ts`
- Modify: `package.json`
- Modify: `README.md`

- [ ] Add failing tests for config defaults/overrides and for the live-Riva gate behavior.
- [ ] Run targeted tests to verify they fail.
- [ ] Implement the minimal production/test-runner changes needed to pass them.
- [ ] Run the full suite plus optional live-Riva command when enabled.
