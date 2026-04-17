/** Push-to-talk and always-on (VAD) modes. One 3-hop session per utterance. */

import readline from "node:readline";
import type { Config } from "./config.ts";
import { openMic, Player } from "./audio.ts";
import { RivaClient, type S2SSession } from "./riva.ts";
import { VadSegmenter } from "./vad.ts";
import * as ui from "./ui.ts";

let lastTranslation = "";

function wireSession(session: S2SSession, player: Player, cfg: Config) {
  // Dim partial English as ASR progresses
  session.events.on("partialTranslation", (text: string) => {
    ui.clr();
    process.stdout.write(ui.pc.dim(`  ${text}`));
  });
  // Final English — settled text
  session.events.on("translation", (text: string) => {
    if (text === lastTranslation) return;
    lastTranslation = text;
    ui.clr();
    console.log(ui.pc.green("  ✓ ") + ui.pc.white(text));
  });
  session.events.on("audio", (buf: Buffer) => {
    if (buf.length === 0) return;
    ui.speaking();
    player.write(buf);
    player.flush(); // close stdin so sox can process and play
  });
  session.events.on("utteranceEnd", () => ui.listening());
  session.events.on("error", (err: Error) => ui.error(err.message));
}

export async function runPushToTalk(cfg: Config): Promise<void> {
  const riva = new RivaClient(cfg);
  const player = new Player(cfg.outputSampleRate);
  const mic = openMic(cfg.inputSampleRate);

  let session: S2SSession | null = null;
  let talking = false;

  const startUtterance = () => {
    talking = true;
    session = riva.openS2S();
    wireSession(session, player, cfg);
    ui.speechDetected();
  };

  const endUtterance = () => {
    if (!talking || !session) return;
    talking = false;
    session.end();
    session = null;
    ui.translating();
  };

  mic.stream.on("data", (chunk: Buffer) => {
    if (talking && session) session.sendAudio(chunk);
  });

  readline.emitKeypressEvents(process.stdin);
  if (process.stdin.isTTY) process.stdin.setRawMode(true);

  let lastSpaceMs = 0;
  let releaseTimer: NodeJS.Timeout | null = null;
  const GAP_MS = 250;

  process.stdin.on("keypress", (_str, key) => {
    if (!key) return;
    if ((key.ctrl && key.name === "c") || key.name === "q") { shutdown(); return; }
    if (key.name === "space") {
      lastSpaceMs = Date.now();
      if (!talking) startUtterance();
      if (releaseTimer) clearTimeout(releaseTimer);
      releaseTimer = setTimeout(() => {
        if (Date.now() - lastSpaceMs >= GAP_MS) endUtterance();
      }, GAP_MS + 20);
    }
  });

  ui.listening();

  const shutdown = () => {
    mic.stop();
    if (session) session.close();
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
  const riva = new RivaClient(cfg);
  const player = new Player(cfg.outputSampleRate);
  const mic = openMic(cfg.inputSampleRate);
  const vad = new VadSegmenter({
    sampleRate: cfg.inputSampleRate,
    aggressiveness: cfg.vadAggressiveness,
    silenceMsToFlush: cfg.silenceMsToFlush,
    maxSegmentMs: cfg.maxSegmentMs,
  });

  let session: S2SSession | null = null;

  const listenInterval = setInterval(() => {
    if (!session) ui.listening();
  }, 400);

  vad.events.on("segmentStart", () => {
    session = riva.openS2S();
    wireSession(session, player, cfg);
    ui.speechDetected();
  });

  vad.events.on("frame", (frame: Buffer) => {
    if (session) session.sendAudio(frame);
  });

  vad.events.on("segmentEnd", () => {
    if (!session) return;
    const s = session;
    session = null;
    s.end();
    ui.translating();
  });

  mic.stream.on("data", (chunk: Buffer) => vad.feed(chunk));

  const shutdown = () => {
    clearInterval(listenInterval);
    mic.stop();
    vad.flush();
    if (session) session.close();
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
