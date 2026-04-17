#!/usr/bin/env bun
/**
 * ar-en-simul — Arabic → English simultaneous interpreter
 *
 * 3-hop gRPC pipeline: Parakeet ASR → Riva NMT → Magpie TTS
 * Each service in its own NIM container on GPU.
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
    gpu: {
      type: "string",
      default: process.env.GPU_HOST ?? "localhost",
      description: "GPU server hostname or IP",
    },
    "asr-port": {
      type: "string",
      default: process.env.RIVA_ASR_PORT ?? "50055",
      description: "ASR gRPC port",
    },
    "nmt-port": {
      type: "string",
      default: process.env.RIVA_NMT_PORT ?? "50051",
      description: "NMT gRPC port",
    },
    "tts-port": {
      type: "string",
      default: process.env.RIVA_TTS_PORT ?? "50056",
      description: "TTS gRPC port",
    },
    tls: {
      type: "boolean",
      default: process.env.RIVA_TLS === "1",
      description: "Use TLS for gRPC",
    },
    "api-key": {
      type: "string",
      default: process.env.RIVA_API_KEY ?? "",
      description: "Bearer token for auth",
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

    const gpu = args.gpu;
    const cfg = loadConfig({
      asrEndpoint: `${gpu}:${args["asr-port"]}`,
      nmtEndpoint: `${gpu}:${args["nmt-port"]}`,
      ttsEndpoint: `${gpu}:${args["tts-port"]}`,
      tls: args.tls,
      apiKey: args["api-key"] || undefined,
      voiceName: args.voice,
      sourceLang: args.source,
      targetLang: args.target,
      verbose: args.verbose,
    });

    // Health check all 3 services
    const services = [
      { name: "ASR", endpoint: cfg.asrEndpoint },
      { name: "NMT", endpoint: cfg.nmtEndpoint },
      { name: "TTS", endpoint: cfg.ttsEndpoint },
    ];

    let allHealthy = true;
    for (const { name, endpoint } of services) {
      ui.connecting(`${name} ${endpoint}`);
      const ok = await checkHealth(endpoint, cfg.tls);
      if (ok) {
        ui.connected(`${name} ${endpoint}`);
      } else {
        ui.connectFailed(`${name} ${endpoint}`, "unreachable");
        allHealthy = false;
      }
    }

    if (!allHealthy) {
      console.log(ui.pc.dim(`\n  Check that all Riva NIMs are running on ${gpu}\n`));
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
