import { beforeEach, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import {
  createLiveController,
  createPushToTalkController,
  type LiveControllerDeps,
  type PushToTalkControllerDeps,
} from "../src/modes.ts";
import type { S2SSession } from "../src/riva.ts";

class FakeSession implements S2SSession {
  readonly events = new EventEmitter();
  sentAudio: Buffer[] = [];
  ended = false;
  closed = false;

  sendAudio(chunk: Buffer): void {
    this.sentAudio.push(Buffer.from(chunk));
  }

  end(): void {
    this.ended = true;
  }

  close(): void {
    this.closed = true;
  }
}

function createPushDeps(): PushToTalkControllerDeps & { session: FakeSession; uiEvents: string[] } {
  const session = new FakeSession();
  const uiEvents: string[] = [];

  return {
    openSession: () => session,
    writeAudio: () => {},
    ui: {
      listening: () => uiEvents.push("listening"),
      speechDetected: () => uiEvents.push("speechDetected"),
      speaking: () => uiEvents.push("speaking"),
      translating: () => uiEvents.push("translating"),
      error: (msg: string) => uiEvents.push(`error:${msg}`),
    },
    scheduleRelease: (fn) => {
      createPushDeps.releaseHandler = fn;
      return { cancel() {} };
    },
    session,
    uiEvents,
  };
}

createPushDeps.releaseHandler = (() => {}) as () => void;

function createLiveDeps(): LiveControllerDeps & { sessions: FakeSession[]; uiEvents: string[] } {
  const sessions: FakeSession[] = [];
  const uiEvents: string[] = [];

  return {
    openSession: () => {
      const session = new FakeSession();
      sessions.push(session);
      return session;
    },
    writeAudio: () => {},
    ui: {
      listening: () => uiEvents.push("listening"),
      speechDetected: () => uiEvents.push("speechDetected"),
      speaking: () => uiEvents.push("speaking"),
      translating: () => uiEvents.push("translating"),
      error: (msg: string) => uiEvents.push(`error:${msg}`),
    },
    sessions,
    uiEvents,
  };
}

describe("createPushToTalkController", () => {
  beforeEach(() => {
    createPushDeps.releaseHandler = () => {};
  });

  test("starts on space, streams mic audio, and ends when release fires", () => {
    const deps = createPushDeps();
    const controller = createPushToTalkController(deps);
    const audio = Buffer.from("audio");

    controller.start();
    controller.handleKeypress({ name: "space" });
    controller.handleMicData(audio);
    createPushDeps.releaseHandler();

    expect(deps.session.sentAudio).toEqual([audio]);
    expect(deps.session.ended).toBe(true);
    expect(deps.uiEvents).toEqual(["listening", "speechDetected", "translating"]);
  });

  test("shuts down the active session without ending the utterance", () => {
    const deps = createPushDeps();
    const controller = createPushToTalkController(deps);

    controller.handleKeypress({ name: "space" });
    controller.shutdown();

    expect(deps.session.closed).toBe(true);
    expect(deps.session.ended).toBe(false);
  });
});

describe("createLiveController", () => {
  test("opens a session for a segment, forwards frames, and ends it on segment end", () => {
    const deps = createLiveDeps();
    const controller = createLiveController(deps);
    const frame = Buffer.from("frame");

    controller.handleSegmentStart();
    controller.handleFrame(frame);
    controller.handleSegmentEnd();

    expect(deps.sessions).toHaveLength(1);
    expect(deps.sessions[0]?.sentAudio).toEqual([frame]);
    expect(deps.sessions[0]?.ended).toBe(true);
    expect(deps.uiEvents).toEqual(["speechDetected", "translating"]);
  });

  test("ignores frames when there is no active session", () => {
    const deps = createLiveDeps();
    const controller = createLiveController(deps);

    controller.handleFrame(Buffer.from("frame"));

    expect(deps.sessions).toHaveLength(0);
  });
});
