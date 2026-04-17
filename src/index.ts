#!/usr/bin/env bun
/**
 * ar-en-simul — Arabic → English simultaneous interpreter
 *
 * Always listening by default. Single gRPC call to Riva NIM cascade
 * (ASR → NMT → TTS) — all on GPU, ~500-900ms end-to-end.
 */

import { defineCommand, runMain } from "citty";
import * as grpc from "@grpc/grpc-js";
import { loadConfig } from "./config.ts";
import { runPushToTalk, runLive } from "./modes.ts";
import * as ui from "./ui.ts";

const main = defineCommand({
  meta: {
    name: "ar-en-simul",
    description: "Arabic → English simultaneous speech translator (NVIDIA Riva NIM)",
    version: "1.0.0",
  },
  args: {
    endpoint: {
      type: "string",
      default: process.env.RIVA_ENDPOINT ?? "localhost:50051",
      description: "Riva NMT gRPC endpoint (host:port)",
    },
    tls: {
      type: "boolean",
      default: process.env.RIVA_TLS === "1",
      description: "Use TLS for gRPC",
    },
    "api-key": {
      type: "string",
      default: process.env.RIVA_API_KEY ?? "",
      description: "Bearer token for the endpoint",
    },
    ptt: {
      type: "boolean",
      default: false,
      description: "Push-to-talk mode (hold SPACE). Default is always-on VAD.",
    },
    voice: {
      type: "string",
      default: process.env.RIVA_VOICE ?? "Magpie-Multilingual.EN-US.Sofia",
      description: "TTS voice name",
    },
    source: {
      type: "string",
      default: "ar-AR",
      description: "Source language (BCP-47)",
    },
    target: {
      type: "string",
      default: "en-US",
      description: "Target language (BCP-47)",
    },
    verbose: {
      type: "boolean",
      default: false,
      description: "Verbose logging",
    },
  },
  async run({ args }) {
    ui.header();

    const cfg = loadConfig({
      endpoint: args.endpoint,
      tls: args.tls,
      apiKey: args["api-key"] || undefined,
      voiceName: args.voice,
      sourceLang: args.source,
      targetLang: args.target,
      verbose: args.verbose,
    });

    // Health check — verify gRPC endpoint is reachable
    ui.connecting(cfg.endpoint);
    const healthy = await checkHealth(cfg.endpoint, cfg.tls);
    if (healthy) {
      ui.connected(cfg.endpoint);
    } else {
      ui.connectFailed(cfg.endpoint, "unreachable");
      console.log(ui.pc.dim(`\n  Check that Riva NIM is running on ${cfg.endpoint}\n`));
      process.exit(1);
    }

    const mode = args.ptt ? "Push-to-talk (SPACE)" : "Always listening";
    ui.ready(mode);

    const run = args.ptt ? runPushToTalk : runLive;
    run(cfg).catch((err) => {
      ui.error(err.message ?? err);
      process.exit(1);
    });
  },
});

async function checkHealth(endpoint: string, tls: boolean): Promise<boolean> {
  return new Promise((resolve) => {
    const creds = tls ? grpc.credentials.createSsl() : grpc.credentials.createInsecure();
    const client = new grpc.Client(endpoint, creds);
    const deadline = new Date(Date.now() + 5000);
    client.waitForReady(deadline, (err) => {
      client.close();
      resolve(!err);
    });
  });
}

runMain(main);
