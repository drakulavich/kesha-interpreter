/** Push-to-talk and always-on (VAD) modes. One 3-hop session per utterance. */

import readline from "node:readline";
import { createWriteStream, writeFileSync, type WriteStream } from "node:fs";
import type { Config } from "./config.ts";
import { openMic, Player } from "./audio.ts";
import { RivaClient, type S2SSession } from "./riva.ts";
import { VadSegmenter } from "./vad.ts";
import * as ui from "./ui.ts";

let lastTranslation = "";
const debug = process.env.DEBUG === "1";
const t0 = Date.now();

function ts() { return `${((Date.now() - t0) / 1000).toFixed(2)}s`; }
function log(msg: string) { if (debug) console.log(ui.pc.dim(`  [${ts()}] ${msg}`)); }

// Debug: save raw mic audio + event log for replay
let audioFile: WriteStream | null = null;
let eventLog: Array<{ ms: number; type: string; data?: string }> = [];

function startDebugRecording() {
  if (!debug) return;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const audioPath = `/tmp/ar-en-debug-${stamp}.raw`;
  const logPath = `/tmp/ar-en-debug-${stamp}.log.json`;
  audioFile = createWriteStream(audioPath);
  eventLog = [];
  console.log(ui.pc.dim(`  [debug] Recording to ${audioPath}`));
  console.log(ui.pc.dim(`  [debug] Event log: ${logPath}`));

  process.on("exit", () => {
    audioFile?.end();
    writeFileSync(logPath, JSON.stringify(eventLog, null, 2));
    console.log(ui.pc.dim(`  [debug] Saved ${eventLog.length} events`));
  });
}

function trackEvent(type: string, data?: string) {
  if (debug) eventLog.push({ ms: Date.now() - t0, type, data });
}

function recordAudio(chunk: Buffer) {
  if (audioFile) audioFile.write(chunk);
}

let muted = false;

function wireSession(session: S2SSession, player: Player, cfg: Config) {
  session.events.on("partial", (text: string) => {
    if (muted) return; // ignore ASR while TTS is playing (echo suppression)
    log(`ASR: ${text.slice(0, 60)}`);
    trackEvent("partial", text);
  });
  let lastPartialShown = "";
  session.events.on("partialTranslation", (text: string) => {
    log(`NMT partial: ${text.slice(0, 60)}`);
    trackEvent("partialTranslation", text);
    if (text === lastPartialShown) return; // skip duplicate
    lastPartialShown = text;
    ui.clr();
    process.stdout.write(ui.pc.dim(`  ${text}`));
  });
  session.events.on("translation", (text: string) => {
    trackEvent("translation", text);
    if (text === lastTranslation) {
      log(`NMT final SKIP (dup): ${text.slice(0, 50)}`);
      return;
    }
    lastTranslation = text;
    log(`NMT final: ${text.slice(0, 60)}`);
    ui.clr();
    console.log(ui.pc.white(`  ${text}`));
  });
  session.events.on("audio", (buf: Buffer) => {
    if (buf.length === 0) return;
    log(`TTS: ${buf.length}b → player (muting mic)`);
    trackEvent("audio", `${buf.length}b`);
    muted = true;
    player.write(buf);
    player.flush();
    // Unmute after estimated playback duration + buffer
    const durationMs = (buf.length / (cfg.outputSampleRate * 2)) * 1000;
    setTimeout(() => { muted = false; log("mic unmuted"); }, durationMs + 300);
  });
  session.events.on("utteranceEnd", () => {
    log("utteranceEnd");
    trackEvent("utteranceEnd");
  });
  session.events.on("end", () => {
    log("session end");
    trackEvent("end");
  });
  session.events.on("error", (err: Error) => {
    log(`ERROR: ${err.message.slice(0, 80)}`);
    trackEvent("error", err.message.slice(0, 100));
    ui.error(err.message);
  });
}

type ReleaseHandle = { cancel(): void };
type Keypress = { ctrl?: boolean; name?: string };

export interface PushToTalkControllerDeps {
  minBufferedBytes: number;
  processAudio(audio: Buffer): Promise<void>;
  scheduleRelease(fn: () => void | Promise<void>): ReleaseHandle;
  onRecordingStart?: () => void;
  onRecordingStop?: (audio: Buffer) => void;
  onShortRecording?: (audio: Buffer) => void;
  onProcessError?: (err: Error) => void;
  ui: {
    recording(): void;
    translating(): void;
    error(msg: string): void;
  };
}

export interface LiveControllerDeps {
  openSession(): S2SSession;
  isMuted?: () => boolean;
  ui?: {
    speechDetected?: () => void;
    translating?: () => void;
    error?: (msg: string) => void;
  };
}

export function createPushToTalkController(deps: PushToTalkControllerDeps) {
  let recording = false;
  let processing = false;
  let audioChunks: Buffer[] = [];
  let releaseHandle: ReleaseHandle | null = null;

  const finishRecording = async () => {
    if (!recording) return;

    recording = false;
    const audio = Buffer.concat(audioChunks);
    audioChunks = [];
    deps.onRecordingStop?.(audio);

    if (audio.length < deps.minBufferedBytes) {
      deps.onShortRecording?.(audio);
      return;
    }

    processing = true;
    deps.ui.translating();

    try {
      await deps.processAudio(audio);
    } catch (err: any) {
      deps.onProcessError?.(err);
      deps.ui.error(err?.message ?? "Pipeline error");
    } finally {
      processing = false;
    }
  };

  return {
    handleKeypress(key: Keypress) {
      if (key.name !== "space" || processing) return;

      if (!recording) {
        recording = true;
        audioChunks = [];
        deps.onRecordingStart?.();
        deps.ui.recording();
      }

      releaseHandle?.cancel();
      releaseHandle = deps.scheduleRelease(() => void finishRecording());
    },
    handleMicData(chunk: Buffer) {
      if (recording) audioChunks.push(Buffer.from(chunk));
    },
    shutdown() {
      releaseHandle?.cancel();
      releaseHandle = null;
      recording = false;
      audioChunks = [];
    },
  };
}

export function createLiveController(deps: LiveControllerDeps) {
  let session: S2SSession | null = null;

  return {
    handleSegmentStart() {
      if (session) return;
      session = deps.openSession();
      deps.ui?.speechDetected?.();
    },
    handleFrame(frame: Buffer) {
      if (!session || deps.isMuted?.()) return;
      session.sendAudio(frame);
    },
    handleSegmentEnd() {
      if (!session) return;
      const activeSession = session;
      session = null;
      activeSession.end();
      deps.ui?.translating?.();
    },
    shutdown() {
      if (!session) return;
      session.close();
      session = null;
    },
  };
}

export async function runPushToTalk(cfg: Config): Promise<void> {
  startDebugRecording();
  const riva = new RivaClient(cfg);
  const player = new Player(cfg.outputSampleRate);
  const mic = openMic(cfg.inputSampleRate);

  const processUtterance = async (audio: Buffer) => {
    trackEvent("processStart");

    trackEvent("asrStart");
    const arabic = await riva.recognizeOffline(audio);
    trackEvent("asrResult", arabic);
    log(`ASR offline: ${arabic.slice(0, 80)}`);

    if (!arabic || arabic.length < 5) {
      log("ASR too short, skipping");
      ui.clr();
      return;
    }

    const english = await riva.translate(arabic);
    trackEvent("translation", english);
    log(`NMT: ${english.slice(0, 80)}`);

    if (!english || english.length < 5) {
      log("NMT too short, skipping");
      ui.clr();
      return;
    }

    ui.clr();
    console.log(ui.pc.white(`  ${english}`));

    const ttsAudio = await riva.synthesize(english);
    trackEvent("audio", `${ttsAudio.length}b`);
    log(`TTS: ${ttsAudio.length}b`);

    if (ttsAudio.length > 0) {
      player.write(ttsAudio);
      player.flush();
    }
  };

  let lastSpaceMs = 0;
  const GAP_MS = 250;

  const controller = createPushToTalkController({
    minBufferedBytes: Math.floor(cfg.inputSampleRate * 2 * 0.3),
    processAudio: processUtterance,
    scheduleRelease: (fn) => {
      const scheduledAt = lastSpaceMs;
      const timer = setTimeout(() => {
        if (scheduledAt === lastSpaceMs) void fn();
      }, GAP_MS + 20);
      return { cancel: () => clearTimeout(timer) };
    },
    onRecordingStart: () => trackEvent("startRecording"),
    onRecordingStop: () => trackEvent("stopRecording"),
    onShortRecording: () => {
      log("Recording too short, skipping");
      ui.clr();
    },
    onProcessError: (err) => {
      log(`ERROR: ${err.message.slice(0, 80)}`);
      trackEvent("error", err.message.slice(0, 100));
    },
    ui,
  });

  mic.stream.on("data", (chunk: Buffer) => {
    recordAudio(chunk);
    controller.handleMicData(chunk);
  });

  readline.emitKeypressEvents(process.stdin);
  if (process.stdin.isTTY) process.stdin.setRawMode(true);

  process.stdin.on("keypress", (_str, key) => {
    if (!key) return;
    if ((key.ctrl && key.name === "c") || key.name === "q") { shutdown(); return; }
    if (key.name === "space") {
      lastSpaceMs = Date.now();
      controller.handleKeypress(key);
    }
  });

  const shutdown = () => {
    controller.shutdown();
    mic.stop();
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

export async function runLive(cfg: Config): Promise<void> {
  startDebugRecording();
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
    openSession: () => {
      const session = riva.openS2S();
      wireSession(session, player, cfg);
      return session;
    },
    isMuted: () => muted,
    ui,
  });

  vad.events.on("segmentStart", () => {
    controller.handleSegmentStart();
    trackEvent("segmentStart");
    log("VAD: segment start");
  });

  vad.events.on("frame", (frame: Buffer) => {
    controller.handleFrame(frame);
  });

  vad.events.on("segmentEnd", () => {
    controller.handleSegmentEnd();
    trackEvent("segmentEnd");
    log("VAD: segment end");
  });

  mic.stream.on("data", (chunk: Buffer) => {
    recordAudio(chunk);
    vad.feed(chunk);
  });

  const shutdown = () => {
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
