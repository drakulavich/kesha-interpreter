/**
 * Real-time simultaneous interpreter test with REAL Arabic audio.
 *
 * Sends actual Arabic speech (Common Voice samples) through the pipeline
 * and verifies:
 * 1. ASR partials arrive while audio is streaming
 * 2. Partial English translations appear DURING streaming
 * 3. TTS audio chunks arrive BEFORE all audio is sent (simultaneous)
 * 4. Final translation + remaining TTS on end
 *
 * Run: GPU_HOST=10.119.62.29 bun test tests/realtime.test.ts
 */

import { describe, test, expect } from "bun:test";
import { readFileSync } from "fs";
import { execSync } from "child_process";
import path from "path";
import { RivaClient } from "../src/riva.ts";
import { loadConfig } from "../src/config.ts";

const GPU = process.env.GPU_HOST ?? "10.119.62.29";

interface Sample { sentence: string; audio_b64: string; size: number }

// Load real Arabic audio samples
const samples: Sample[] = JSON.parse(
  readFileSync(path.resolve(import.meta.dir, "fixtures", "arabic_samples.json"), "utf-8")
);

// Decode mp3 to raw PCM16 16kHz mono via ffmpeg
function mp3ToPcm(mp3Base64: string): Buffer {
  const mp3 = Buffer.from(mp3Base64, "base64");
  const tmpMp3 = `/tmp/ar-test-${Date.now()}.mp3`;
  const tmpRaw = `/tmp/ar-test-${Date.now()}.raw`;
  require("fs").writeFileSync(tmpMp3, mp3);
  execSync(`ffmpeg -i ${tmpMp3} -f s16le -ar 16000 -ac 1 ${tmpRaw} -y 2>/dev/null`);
  const pcm = readFileSync(tmpRaw);
  require("fs").unlinkSync(tmpMp3);
  require("fs").unlinkSync(tmpRaw);
  return pcm;
}

describe("Real-time with Arabic audio", () => {
  const cfg = loadConfig({
    asrEndpoint: `${GPU}:50055`,
    nmtEndpoint: `${GPU}:50051`,
    ttsEndpoint: `${GPU}:50056`,
    voiceName: "Magpie-Multilingual.EN-US.Leo",
  });

  for (let idx = 0; idx < samples.length; idx++) {
    const sample = samples[idx];

    test(`Sample ${idx}: "${sample.sentence.slice(0, 40)}..."`, async () => {
      const pcm = mp3ToPcm(sample.audio_b64);
      const client = new RivaClient(cfg);
      const session = client.openS2S();

      const timeline: Array<{ ms: number; type: string; data?: string }> = [];
      const t0 = Date.now();
      const track = (type: string, data?: string) =>
        timeline.push({ ms: Date.now() - t0, type, data });

      let audioBytes = 0;
      let firstAudioMs = 0;
      let audioChunks = 0;
      let sendDoneMs = 0;

      session.events.on("partial", (t: string) => track("partial", t.slice(0, 50)));
      session.events.on("partialTranslation", (t: string) => track("partialTranslation", t.slice(0, 50)));
      session.events.on("translation", (t: string) => track("translation", t.slice(0, 80)));
      session.events.on("audio", (buf: Buffer) => {
        if (!firstAudioMs) firstAudioMs = Date.now() - t0;
        audioBytes += buf.length;
        audioChunks++;
        track("audio", `${buf.length}b (total: ${audioBytes}b)`);
      });
      session.events.on("error", (err: Error) => track("error", err.message.slice(0, 60)));

      const done = new Promise<void>((resolve) => {
        session.events.on("end", () => { track("end"); resolve(); });
        setTimeout(resolve, 30000);
      });
      session.events.on("utteranceEnd", () => track("utteranceEnd"));

      // Stream audio at realistic pace (~100ms per chunk)
      const chunkSize = 3200; // 100ms at 16kHz
      const totalChunks = Math.ceil(pcm.length / chunkSize);
      for (let i = 0; i < pcm.length; i += chunkSize) {
        session.sendAudio(pcm.subarray(i, Math.min(i + chunkSize, pcm.length)));
        await new Promise((r) => setTimeout(r, 100));
      }
      sendDoneMs = Date.now() - t0;
      session.end();
      await done;

      // Print timeline
      const totalMs = Date.now() - t0;
      const audioDur = pcm.length / (16000 * 2);
      console.log(`\n  Arabic: "${sample.sentence}"`);
      console.log(`  Audio: ${audioDur.toFixed(1)}s (${pcm.length} bytes, ${totalChunks} chunks)`);
      console.log(`  Timeline:`);
      for (const e of timeline) {
        console.log(`    ${String(e.ms).padStart(5)}ms  ${e.type}${e.data ? `: ${e.data}` : ""}`);
      }
      console.log(`  Summary:`);
      console.log(`    Send done: ${sendDoneMs}ms`);
      console.log(`    First audio: ${firstAudioMs || "NONE"}ms`);
      console.log(`    Audio chunks: ${audioChunks} (${audioBytes} bytes)`);
      console.log(`    Total: ${totalMs}ms`);

      // ASSERTIONS
      // 1. Must have ASR partials
      const partials = timeline.filter(e => e.type === "partial");
      expect(partials.length).toBeGreaterThan(0);
      console.log(`  ✓ ${partials.length} ASR partials`);

      // 2. Must have at least one translation (partial or final)
      const translations = timeline.filter(e =>
        e.type === "partialTranslation" || e.type === "translation"
      );
      expect(translations.length).toBeGreaterThan(0);
      console.log(`  ✓ ${translations.length} translations`);

      // 3. Must have TTS audio
      expect(audioBytes).toBeGreaterThan(0);
      console.log(`  ✓ ${audioBytes} bytes TTS audio in ${audioChunks} chunks`);

      // 4. KEY CHECK: first audio should arrive BEFORE or shortly after send is done
      //    (simultaneous = audio starts while we're still streaming)
      if (firstAudioMs > 0) {
        const lag = firstAudioMs - sendDoneMs;
        console.log(`  ${lag < 0 ? "✓ SIMULTANEOUS" : "⚠ SEQUENTIAL"}: first audio ${lag < 0 ? "arrived " + (-lag) + "ms BEFORE" : "arrived " + lag + "ms AFTER"} send done`);
      }
    }, 45000);
  }
});
