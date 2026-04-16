/**
 * The two interaction modes.
 *
 * Both of them share the same core idea: one Riva streaming-S2S call per
 * utterance. When the utterance ends, we .end() the stream so the server
 * flushes the tail of the translation, then we open a fresh stream for the
 * next utterance. This matches how Riva's cascade buffers its outputs.
 */
import chalk from "chalk";
import readline from "node:readline";
import type { Config } from "./config.ts";
import { openMic, Player } from "./audio.ts";
import { RivaClient, type S2SSession } from "./riva.ts";
import { VadSegmenter } from "./vad.ts";

export async function runPushToTalk(cfg: Config): Promise<void> {
  const riva = new RivaClient(cfg);
  const player = new Player(cfg.outputSampleRate);
  const mic = openMic(cfg.inputSampleRate);

  let session: S2SSession | null = null;
  let talking = false;
  let utterance = 0;

  const startUtterance = () => {
    utterance += 1;
    const n = utterance;
    talking = true;
    session = riva.openS2S();
    process.stdout.write(chalk.green(`\n[${n}] ▶ speak (release space to translate)\n`));
    session.events.on("audio", (buf: Buffer) => player.write(buf));
    session.events.on("error", (err: Error) => {
      console.error(chalk.red(`[${n}] riva error:`), err.message);
    });
    session.events.on("end", () => {
      if (cfg.verbose) process.stdout.write(chalk.gray(`[${n}] stream closed\n`));
    });
  };

  const endUtterance = () => {
    if (!talking || !session) return;
    talking = false;
    session.end();
    session = null;
    process.stdout.write(chalk.cyan("… translating …\n"));
  };

  mic.stream.on("data", (chunk: Buffer) => {
    if (talking && session) session.sendAudio(chunk);
  });

  // Keypress handling: hold SPACE to talk, release to finalize. q or Ctrl+C quits.
  readline.emitKeypressEvents(process.stdin);
  if (process.stdin.isTTY) process.stdin.setRawMode(true);

  // In a terminal, "holding" a key yields key-repeat events rather than a clean
  // down/up. We treat "any space press within 250ms of the last one" as still
  // held, and auto-release after the gap.
  let lastSpaceMs = 0;
  let releaseTimer: NodeJS.Timeout | null = null;
  const GAP_MS = 250;

  process.stdin.on("keypress", (_str, key) => {
    if (!key) return;
    if ((key.ctrl && key.name === "c") || key.name === "q") {
      shutdown();
      return;
    }
    if (key.name === "space") {
      lastSpaceMs = Date.now();
      if (!talking) startUtterance();
      if (releaseTimer) clearTimeout(releaseTimer);
      releaseTimer = setTimeout(() => {
        if (Date.now() - lastSpaceMs >= GAP_MS) endUtterance();
      }, GAP_MS + 20);
    }
  });

  process.stdout.write(
    chalk.bold("\nPush-to-talk mode\n") +
      chalk.dim("Hold SPACE to speak Arabic. Release to translate.  Press q to quit.\n"),
  );
  mic.start();

  const shutdown = () => {
    mic.stop();
    if (session) session.close();
    player.close();
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    process.stdout.write("\n");
    process.exit(0);
  };
  process.on("SIGINT", shutdown);

  // Keep the event loop alive.
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
  let utterance = 0;

  vad.events.on("segmentStart", () => {
    utterance += 1;
    const n = utterance;
    session = riva.openS2S();
    process.stdout.write(chalk.green(`\n[${n}] ▶ speech detected\n`));
    session.events.on("audio", (buf: Buffer) => player.write(buf));
    session.events.on("error", (err: Error) => {
      console.error(chalk.red(`[${n}] riva error:`), err.message);
    });
  });

  vad.events.on("frame", (frame: Buffer) => {
    if (session) session.sendAudio(frame);
  });

  vad.events.on("segmentEnd", () => {
    if (!session) return;
    const s = session;
    session = null;
    s.end();
    process.stdout.write(chalk.cyan("… translating …\n"));
  });

  mic.stream.on("data", (chunk: Buffer) => vad.feed(chunk));

  process.stdout.write(
    chalk.bold("\nLive (VAD) mode\n") +
      chalk.dim("Just start speaking Arabic. Each sentence is translated as you pause.  Ctrl+C to quit.\n"),
  );
  mic.start();

  const shutdown = () => {
    mic.stop();
    vad.flush();
    if (session) session.close();
    player.close();
    process.stdout.write("\n");
    process.exit(0);
  };
  process.on("SIGINT", shutdown);

  return new Promise(() => {});
}
