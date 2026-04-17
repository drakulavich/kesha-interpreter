/**
 * Unit tests for src/audio.ts
 *
 * openMic() and Player both spawn real OS subprocesses (sox/rec/play), so we
 * mock `child_process.spawn` to avoid any system dependency.  The tests verify
 * the public contract of each export, not the sox command-line arguments.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

// ─── spawn mock ──────────────────────────────────────────────────────────────

/** Minimal fake ChildProcess returned by the mocked spawn(). */
function makeFakeProc() {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const proc = Object.assign(new EventEmitter(), {
    stdin,
    stdout,
    kill: mock(() => {}),
    pid: 1234,
  });
  return proc;
}

let fakeProc: ReturnType<typeof makeFakeProc>;
let spawnMock: ReturnType<typeof mock>;

// We mock the module before importing audio.ts so the module resolution picks
// up the mock.  Bun supports mock.module() for ESM mocking.
mock.module("child_process", () => {
  spawnMock = mock((..._args: unknown[]) => fakeProc);
  return { spawn: spawnMock };
});

// Dynamic import AFTER the mock is installed so audio.ts sees the mocked spawn.
const { openMic, Player } = await import("../src/audio.ts");

// ─── openMic ─────────────────────────────────────────────────────────────────

describe("openMic", () => {
  beforeEach(() => {
    fakeProc = makeFakeProc();
  });

  afterEach(() => {
    spawnMock.mockClear();
  });

  test("returns an object with a stream property", () => {
    const handle = openMic(16_000);
    expect(handle.stream).toBeDefined();
  });

  test("returns an object with a stop function", () => {
    const handle = openMic(16_000);
    expect(typeof handle.stop).toBe("function");
  });

  test("stream is the stdout of the spawned process", () => {
    const handle = openMic(16_000);
    expect(handle.stream).toBe(fakeProc.stdout);
  });

  test("stop() calls kill(SIGTERM) on the underlying process", () => {
    const handle = openMic(16_000);
    handle.stop();
    expect(fakeProc.kill).toHaveBeenCalledWith("SIGTERM");
  });

  test("stop() can be called multiple times without throwing", () => {
    const handle = openMic(16_000);
    expect(() => {
      handle.stop();
      handle.stop();
    }).not.toThrow();
  });

  test("spawns a process for each openMic() call", () => {
    openMic(16_000);
    const count1 = spawnMock.mock.calls.length;

    fakeProc = makeFakeProc();
    openMic(44_100);
    const count2 = spawnMock.mock.calls.length;

    expect(count2).toBe(count1 + 1);
  });
});

// ─── Player ──────────────────────────────────────────────────────────────────

describe("Player", () => {
  beforeEach(() => {
    fakeProc = makeFakeProc();
  });

  afterEach(() => {
    spawnMock.mockClear();
  });

  test("constructs without throwing", () => {
    expect(() => new Player(22_050)).not.toThrow();
  });

  test("does not spawn a process on construction", () => {
    const callsBefore = spawnMock.mock.calls.length;
    new Player(22_050);
    expect(spawnMock.mock.calls.length).toBe(callsBefore);
  });

  test("spawns a process on the first write() call", () => {
    const player = new Player(22_050);
    const callsBefore = spawnMock.mock.calls.length;

    player.write(Buffer.from("audio-data"));

    expect(spawnMock.mock.calls.length).toBe(callsBefore + 1);
  });

  test("does not spawn a second process on subsequent write() calls", () => {
    const player = new Player(22_050);
    player.write(Buffer.from("first"));
    const callsAfterFirst = spawnMock.mock.calls.length;

    player.write(Buffer.from("second"));

    expect(spawnMock.mock.calls.length).toBe(callsAfterFirst);
  });

  test("close() ends stdin without throwing when no process is running", () => {
    const player = new Player(22_050);
    expect(() => player.close()).not.toThrow();
  });

  test("close() ends stdin without throwing when a process is running", () => {
    const player = new Player(22_050);
    player.write(Buffer.from("audio"));
    expect(() => player.close()).not.toThrow();
  });

  test("write() does not throw when called after close()", () => {
    const player = new Player(22_050);
    player.write(Buffer.from("audio"));
    player.close();
    expect(() => player.write(Buffer.from("more"))).not.toThrow();
  });

  test("spawns a new process after the previous one closes", async () => {
    const player = new Player(22_050);

    // First write — spawns proc
    player.write(Buffer.from("audio"));
    const callsAfterFirst = spawnMock.mock.calls.length;

    // Simulate the process closing naturally
    fakeProc.emit("close");
    // Give the event loop a tick to process the close handler
    await new Promise(r => setTimeout(r, 0));

    // Set up a new fake proc for the next spawn
    fakeProc = makeFakeProc();

    // Second write after proc closed — should spawn again
    player.write(Buffer.from("more"));
    expect(spawnMock.mock.calls.length).toBe(callsAfterFirst + 1);
  });
});
