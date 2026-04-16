#!/usr/bin/env bun
/**
 * ar-en-simul: simultaneous Arabic → English speech translator.
 *
 * Usage:
 *   bun run src/index.ts                        # push-to-talk (default)
 *   bun run src/index.ts --live                 # VAD / always-on
 *   bun run src/index.ts --endpoint 10.0.0.5:50051
 *   bun run src/index.ts --voice English-US.Male-1 --verbose
 */
import { Command } from "commander";
import chalk from "chalk";
import { loadConfig } from "./config.ts";
import { runPushToTalk, runLive } from "./modes.ts";

const program = new Command();
program
  .name("ar-en-simul")
  .description("Simultaneous Arabic → English speech translator (NVIDIA Riva NIM)")
  .option("--endpoint <host:port>", "Riva NMT gRPC endpoint", process.env.RIVA_ENDPOINT ?? "localhost:50051")
  .option("--tls", "use TLS for the gRPC connection", process.env.RIVA_TLS === "1")
  .option("--api-key <key>", "bearer token for the endpoint", process.env.RIVA_API_KEY)
  .option("--live", "use VAD (always-on) mode instead of push-to-talk", false)
  .option("--voice <name>", "Riva TTS voice name", "English-US.Female-1")
  .option("--source <bcp47>", "source language code", "ar-AR")
  .option("--target <bcp47>", "target language code", "en-US")
  .option("--model <name>", "Riva S2S model name", "s2s_model")
  .option("--in-sr <hz>", "mic sample rate in Hz", (v) => Number(v), 16000)
  .option("--out-sr <hz>", "playback sample rate in Hz", (v) => Number(v), 44100)
  .option("--vad <0-3>", "VAD aggressiveness (live mode)", (v) => Number(v), 2)
  .option("--silence-ms <ms>", "silence to flush a segment (live mode)", (v) => Number(v), 600)
  .option("--max-segment-ms <ms>", "hard cap per segment (live mode)", (v) => Number(v), 8000)
  .option("-v, --verbose", "verbose logging", false);

program.parse();
const opts = program.opts();

const cfg = loadConfig({
  endpoint: opts.endpoint,
  tls: !!opts.tls,
  apiKey: opts.apiKey,
  voiceName: opts.voice,
  sourceLang: opts.source,
  targetLang: opts.target,
  s2sModel: opts.model,
  inputSampleRate: opts.inSr,
  outputSampleRate: opts.outSr,
  vadAggressiveness: Math.max(0, Math.min(3, opts.vad)) as 0 | 1 | 2 | 3,
  silenceMsToFlush: opts.silenceMs,
  maxSegmentMs: opts.maxSegmentMs,
  verbose: !!opts.verbose,
});

process.stdout.write(
  chalk.bold("ar-en-simul  ") +
    chalk.dim(
      `→ ${cfg.endpoint}${cfg.tls ? " (TLS)" : ""}  ${cfg.sourceLang} → ${cfg.targetLang}  voice=${cfg.voiceName}\n`,
    ),
);

const main = opts.live ? runLive : runPushToTalk;
main(cfg).catch((err) => {
  console.error(chalk.red("fatal:"), err);
  process.exit(1);
});
