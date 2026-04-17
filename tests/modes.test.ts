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

function createPushDeps(): PushToTalkControllerDeps & {
  processed: Buffer[];
  uiEvents: string[];
  cancelled: { value: boolean };
} {
  const uiEvents: string[] = [];
  const processed: Buffer[] = [];
  const cancelled = { value: false };

  return {
    minBufferedBytes: 5,
    processAudio: async (audio: Buffer) => {
      processed.push(Buffer.from(audio));
    },
    ui: {
      recording: () => uiEvents.push("recording"),
      translating: () => uiEvents.push("translating"),
      error: (msg: string) => uiEvents.push(`error:${msg}`),
    },
    scheduleRelease: (fn) => {
      createPushDeps.releaseHandler = fn;
      return {
        cancel() {
          cancelled.value = true;
        },
      };
    },
    processed,
    uiEvents,
    cancelled,
  };
}

createPushDeps.releaseHandler = (async () => {}) as () => Promise<void>;

function createLiveDeps(): LiveControllerDeps & { sessions: FakeSession[]; uiEvents: string[] } {
  const sessions: FakeSession[] = [];
  const uiEvents: string[] = [];

  return {
    openSession: () => {
      const session = new FakeSession();
      sessions.push(session);
      return session;
    },
    ui: {
      speechDetected: () => uiEvents.push("speechDetected"),
      translating: () => uiEvents.push("translating"),
      error: (msg: string) => uiEvents.push(`error:${msg}`),
    },
    sessions,
    uiEvents,
  };
}

describe("createPushToTalkController", () => {
  beforeEach(() => {
    createPushDeps.releaseHandler = async () => {};
  });

  test("buffers mic audio while space is held and processes it when release fires", async () => {
    const deps = createPushDeps();
    const controller = createPushToTalkController(deps);
    const firstChunk = Buffer.from("hello");
    const secondChunk = Buffer.from("world");

    controller.handleKeypress({ name: "space" });
    controller.handleMicData(firstChunk);
    controller.handleMicData(secondChunk);
    await createPushDeps.releaseHandler();

    expect(deps.processed).toEqual([Buffer.concat([firstChunk, secondChunk])]);
    expect(deps.uiEvents).toEqual(["recording", "translating"]);
  });

  test("skips short recordings", async () => {
    const deps = createPushDeps();
    const controller = createPushToTalkController(deps);

    controller.handleKeypress({ name: "space" });
    controller.handleMicData(Buffer.from("no"));
    await createPushDeps.releaseHandler();

    expect(deps.processed).toEqual([]);
    expect(deps.uiEvents).toEqual(["recording"]);
  });

  test("cancels the pending release timer during shutdown", () => {
    const deps = createPushDeps();
    const controller = createPushToTalkController(deps);

    controller.handleKeypress({ name: "space" });
    controller.shutdown();

    expect(deps.cancelled.value).toBe(true);
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
