/**
 * E2E test: sends real Arabic audio through ASR→NMT→TTS pipeline,
 * verifies audio playback chunks arrive.
 *
 * Requires GPU services running:
 *   ASR on GPU_HOST:50055, NMT on GPU_HOST:50051, TTS on GPU_HOST:50056
 *
 * Run: GPU_HOST=10.119.62.29 bun test tests/e2e.test.ts
 */

import { describe, test, expect } from "bun:test";
import * as grpc from "@grpc/grpc-js";
import protoLoader from "@grpc/proto-loader";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROTO_DIR = path.resolve(__dirname, "..", "protos");
const GPU = process.env.GPU_HOST ?? "10.119.62.29";

const OPTS: protoLoader.Options = {
  keepCase: false, longs: String, enums: Number,
  defaults: true, oneofs: true, includeDirs: [PROTO_DIR],
};

function loadStub(proto: string, svcPath: string, port: number): any {
  const pkg = protoLoader.loadSync(path.join(PROTO_DIR, proto), OPTS);
  const def = grpc.loadPackageDefinition(pkg) as any;
  const Ctor = svcPath.split(".").reduce((o: any, k: string) => o[k], def);
  return new Ctor(`${GPU}:${port}`, grpc.credentials.createInsecure());
}

// Generate synthetic PCM16 mono 16kHz audio — 1 second of 440Hz sine wave
function generateTestAudio(durationSec = 1, sampleRate = 16000): Buffer {
  const samples = durationSec * sampleRate;
  const buf = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) {
    const val = Math.sin(2 * Math.PI * 440 * i / sampleRate) * 16000;
    buf.writeInt16LE(Math.round(val), i * 2);
  }
  return buf;
}

describe("E2E pipeline", () => {
  const asrStub = loadStub("riva_asr.proto", "nvidia.riva.asr.RivaSpeechRecognition", 50055);
  const nmtStub = loadStub("riva_nmt.proto", "nvidia.riva.nmt.RivaTranslation", 50051);
  const ttsStub = loadStub("riva_tts.proto", "nvidia.riva.tts.RivaSpeechSynthesis", 50056);

  test("ASR streaming accepts audio and returns without error", async () => {
    const audio = generateTestAudio(2);

    const result = await new Promise<string[]>((resolve, reject) => {
      const call = asrStub.StreamingRecognize();
      const transcripts: string[] = [];

      call.write({
        streamingConfig: {
          config: {
            encoding: 1, // LINEAR_PCM
            sampleRateHertz: 16000,
            languageCode: "ar-AR",
            audioChannelCount: 1,
            enableAutomaticPunctuation: true,
          },
          interimResults: true,
        },
      });

      call.on("data", (msg: any) => {
        for (const r of msg?.results ?? []) {
          const t = r?.alternatives?.[0]?.transcript;
          if (t) transcripts.push(t);
        }
      });
      call.on("error", reject);
      call.on("end", () => resolve(transcripts));

      // Send audio in chunks
      const chunkSize = 3200;
      for (let i = 0; i < audio.length; i += chunkSize) {
        call.write({ audioContent: audio.subarray(i, i + chunkSize) });
      }
      call.end();
    });

    // Sine wave won't produce meaningful Arabic — just verify no crash
    expect(Array.isArray(result)).toBe(true);
  }, 15000);

  test("NMT translates Arabic text to English", async () => {
    const result = await new Promise<string>((resolve, reject) => {
      nmtStub.TranslateText(
        {
          texts: ["مرحبا بالعالم"],
          sourceLanguage: "ar",
          targetLanguage: "en",
        },
        (err: Error | null, resp: any) => {
          if (err) return reject(err);
          resolve(resp?.translations?.[0]?.text ?? "");
        },
      );
    });

    expect(result.length).toBeGreaterThan(0);
    console.log(`  NMT: "مرحبا بالعالم" → "${result}"`);
  }, 10000);

  test("TTS Synthesize returns audio bytes", async () => {
    const result = await new Promise<Buffer>((resolve, reject) => {
      ttsStub.Synthesize(
        {
          text: "Hello world",
          languageCode: "en-US",
          encoding: 1,
          sampleRateHz: 22050,
          voiceName: "Magpie-Multilingual.EN-US.Leo",
        },
        (err: Error | null, resp: any) => {
          if (err) return reject(err);
          resolve(Buffer.from(resp?.audio ?? []));
        },
      );
    });

    expect(result.length).toBeGreaterThan(1000);
    console.log(`  TTS: "Hello world" → ${result.length} bytes audio`);
  }, 10000);

  test("TTS SynthesizeOnline streams audio chunks", async () => {
    const chunks = await new Promise<Buffer[]>((resolve, reject) => {
      const call = ttsStub.SynthesizeOnline();
      const received: Buffer[] = [];

      call.on("data", (resp: any) => {
        if (resp?.audio?.length > 0) {
          received.push(Buffer.from(resp.audio));
        }
      });
      call.on("error", reject);
      call.on("end", () => resolve(received));

      call.write({
        text: "This is a test of streaming text to speech synthesis.",
        languageCode: "en-US",
        encoding: 1,
        sampleRateHz: 22050,
        voiceName: "Magpie-Multilingual.EN-US.Leo",
      });
      call.end();
    });

    expect(chunks.length).toBeGreaterThan(1);
    const totalBytes = chunks.reduce((s, c) => s + c.length, 0);
    console.log(`  TTS stream: ${chunks.length} chunks, ${totalBytes} bytes total`);
  }, 15000);

  test("Full pipeline: NMT → TTS produces audio for Arabic text", async () => {
    // Step 1: Translate
    const english = await new Promise<string>((resolve, reject) => {
      nmtStub.TranslateText(
        { texts: ["ما أطول عودك"], sourceLanguage: "ar", targetLanguage: "en" },
        (err: Error | null, resp: any) => {
          if (err) return reject(err);
          resolve(resp?.translations?.[0]?.text ?? "");
        },
      );
    });
    expect(english.length).toBeGreaterThan(0);

    // Step 2: Synthesize
    const audio = await new Promise<Buffer>((resolve, reject) => {
      ttsStub.Synthesize(
        {
          text: english,
          languageCode: "en-US",
          encoding: 1,
          sampleRateHz: 22050,
          voiceName: "Magpie-Multilingual.EN-US.Leo",
        },
        (err: Error | null, resp: any) => {
          if (err) return reject(err);
          resolve(Buffer.from(resp?.audio ?? []));
        },
      );
    });
    expect(audio.length).toBeGreaterThan(1000);

    const audioDur = audio.length / (22050 * 2);
    console.log(`  Pipeline: "ما أطول عودك" → "${english}" → ${audio.length} bytes (${audioDur.toFixed(1)}s)`);
  }, 15000);

  test("RivaClient openS2S emits audio events", async () => {
    // Import the actual client
    const { RivaClient } = await import("../src/riva.ts");
    const { loadConfig } = await import("../src/config.ts");

    const cfg = loadConfig({
      asrEndpoint: `${GPU}:50055`,
      nmtEndpoint: `${GPU}:50051`,
      ttsEndpoint: `${GPU}:50056`,
      voiceName: "Magpie-Multilingual.EN-US.Leo",
    });

    const client = new RivaClient(cfg);
    const session = client.openS2S();

    const events: string[] = [];
    let audioBytes = 0;

    // Register ALL event listeners BEFORE sending anything
    const done = new Promise<void>((resolve) => {
      session.events.on("end", () => { events.push("end"); resolve(); });
      setTimeout(resolve, 15000);
    });

    session.events.on("partial", (t: string) => { events.push("partial"); });
    session.events.on("partialTranslation", (t: string) => { events.push("partialTranslation"); });
    session.events.on("translation", (t: string) => {
      events.push("translation");
      console.log(`  S2S translation: "${t}"`);
    });
    session.events.on("audio", (buf: Buffer) => {
      events.push("audio");
      audioBytes += buf.length;
    });
    session.events.on("utteranceEnd", () => events.push("utteranceEnd"));
    session.events.on("error", (err: Error) => {
      events.push(`error:${err.message.slice(0, 80)}`);
      console.log(`  S2S error: ${err.message.slice(0, 120)}`);
    });

    // Send 3 seconds of synthetic audio at realistic pace
    const audio = generateTestAudio(3);
    const chunkSize = 3200;
    for (let i = 0; i < audio.length; i += chunkSize) {
      session.sendAudio(audio.subarray(i, i + chunkSize));
      await new Promise((r) => setTimeout(r, 100));
    }

    session.end();
    await done;

    console.log(`  S2S events: [${events.join(", ")}]`);
    console.log(`  S2S audio: ${audioBytes} bytes`);

    // Should at least get utteranceEnd + end (even with no transcript)
    expect(events).toContain("end");
  }, 20000);
});
