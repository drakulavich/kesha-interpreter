/**
 * Push-to-talk and always-on (VAD) modes.
 *
 * One Riva S2S stream per utterance. When the utterance ends, we .end()
 * the stream so the server flushes translation, then open a fresh one.
 */

import readline from "node:readline";
import type { Config } from "./config.ts";
import { openMic, Player } from "./audio.ts";
import { RivaClient, type S2SSession } from "./riva.ts";
import { VadSegmenter } from "./vad.ts";
import * as ui from "./ui.ts";

interface ModeUi {
  listening(): void;
  speechDetected(): void;
  speaking(): void;
  translating(): void;
  error(msg: string): void;
}

interface Cancelable {
  cancel(): void;
}

interface Keypress {
  ctrl?: boolean;
  name?: string;
}

export interface PushToTalkControllerDeps {
  openSession(): S2SSession;
  writeAudio(chunk: Buffer): void;
  ui: ModeUi;
  scheduleRelease?(fn: () => void, delayMs?: number): Cancelable;
}

export interface LiveControllerDeps {
  openSession(): S2SSession;
  writeAudio(chunk: Buffer): void;
  ui: ModeUi;
}

function bindSession(session: S2SSession, deps: { writeAudio(chunk: Buffer): void; ui: ModeUi }): void {
  session.events.on("audio", (buf: Buffer) => {
    deps.ui.speaking();
    deps.writeAudio(buf);
  });
  session.events.on("error", (err: Error) => deps.ui.error(err.message));
  session.events.on("utteranceEnd", () => deps.ui.listening());
}

function defaultScheduleRelease(fn: () => void, delayMs = 0): Cancelable {
  const timer = setTimeout(fn, delayMs);
  return {
    cancel() {
      clearTimeout(timer);
    },
  };
}

export function createPushToTalkController(deps: PushToTalkControllerDeps) {
  let session: S2SSession | null = null;
  let talking = false;
  let releaseHandle: Cancelable | null = null;
  const scheduleRelease = deps.scheduleRelease ?? defaultScheduleRelease;
  const GAP_MS = 250;

  const startUtterance = () => {
    talking = true;
    session = deps.openSession();
    bindSession(session, deps);
    session.events.on("end", () => {
      if (!talking) deps.ui.listening();
    });
    deps.ui.speechDetected();
  };

  const endUtterance = () => {
    if (!talking || !session) return;
    talking = false;
    session.end();
    session = null;
    deps.ui.translating();
  };

  return {
    start() {
      deps.ui.listening();
    },
    handleKeypress(key: Keypress) {
      if ((key.ctrl && key.name === "c") || key.name === "q") return "quit";
      if (key.name !== "space") return;

      if (!talking) startUtterance();
      releaseHandle?.cancel();
      releaseHandle = scheduleRelease(() => {
        endUtterance();
      }, GAP_MS + 20);
    },
    handleMicData(chunk: Buffer) {
      if (talking && session) session.sendAudio(chunk);
    },
    shutdown() {
      releaseHandle?.cancel();
      session?.close();
      session = null;
      talking = false;
    },
  };
}

export function createLiveController(deps: LiveControllerDeps) {
  let session: S2SSession | null = null;

  return {
    handleSegmentStart() {
      session = deps.openSession();
      bindSession(session, deps);
      deps.ui.speechDetected();
    },
    handleFrame(frame: Buffer) {
      session?.sendAudio(frame);
    },
    handleSegmentEnd() {
      if (!session) return;
      const currentSession = session;
      session = null;
      currentSession.end();
      deps.ui.translating();
    },
    isIdle() {
      return session === null;
    },
    shutdown() {
      session?.close();
      session = null;
    },
  };
}

// ── Push-to-talk ─────────────────────────────────────────────────

export async function runPushToTalk(cfg: Config): Promise<void> {
  const riva = new RivaClient(cfg);
  const player = new Player(cfg.outputSampleRate);
  const mic = openMic(cfg.inputSampleRate);
  const controller = createPushToTalkController({
    openSession: () => riva.openS2S(),
    writeAudio: (chunk) => player.write(chunk),
    ui,
  });

  mic.stream.on("data", (chunk: Buffer) => {
    controller.handleMicData(chunk);
  });

  readline.emitKeypressEvents(process.stdin);
  if (process.stdin.isTTY) process.stdin.setRawMode(true);

  process.stdin.on("keypress", (_str, key) => {
    if (!key) return;
    if (controller.handleKeypress(key) === "quit") shutdown();
  });

  mic.start();
  controller.start();

  const shutdown = () => {
    mic.stop();
    controller.shutdown();
    player.close();
    ui.clr();
    ui.showCursor();
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    console.log();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  return new Promise(() => {});
}

// ── Always-on (VAD) ──────────────────────────────────────────────

export async function runLive(cfg: Config): Promise<void> {
  const riva = new RivaClient(cfg);
  const player = new Player(cfg.outputSampleRate);
  const mic = openMic(cfg.inputSampleRate);
  const vad = new VadSegmenter({
    sampleRate: cfg.inputSampleRate,
    aggressiveness: cfg.vadAggressiveness,
    silenceMsToFlush: cfg.silenceMsToFlush,
    maxSegmentMs: cfg.maxSegmentMs,
  });
  const controller = createLiveController({
    openSession: () => riva.openS2S(),
    writeAudio: (chunk) => player.write(chunk),
    ui,
  });

  // Breathing dot animation while idle
  const listenInterval = setInterval(() => {
    if (controller.isIdle()) ui.listening();
  }, 400);

  vad.events.on("segmentStart", () => {
    controller.handleSegmentStart();
  });

  vad.events.on("frame", (frame: Buffer) => {
    controller.handleFrame(frame);
  });

  vad.events.on("segmentEnd", () => {
    controller.handleSegmentEnd();
  });

  mic.stream.on("data", (chunk: Buffer) => vad.feed(chunk));
  mic.start();

  const shutdown = () => {
    clearInterval(listenInterval);
    mic.stop();
    vad.flush();
    controller.shutdown();
    player.close();
    ui.clr();
    ui.showCursor();
    console.log();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Quit on q
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on("data", (chunk) => {
      const key = chunk.toString();
      if (key === "\x03" || key === "q" || key === "Q") shutdown();
    });
  }

  return new Promise(() => {});
}
