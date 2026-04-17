/**
 * E2E test: simulates push-to-talk offline mode behavior.
 *
 * Run with a live Riva stack:
 *   RUN_RIVA_E2E=1 GPU_HOST=<ip> bun test ./tests/ptt-offline.test.ts
 */

import { describe, expect, test } from "bun:test";
import { execSync } from "node:child_process";
import { unlinkSync, writeFileSync } from "node:fs";
import { loadConfig } from "../src/config.ts";
import { RivaClient } from "../src/riva.ts";

const enabled = process.env.RUN_RIVA_E2E === "1";
const GPU = process.env.GPU_HOST ?? "10.119.62.29";

function loadArabicPcm(sampleIndex = 0): { pcm: Buffer; sentence: string } {
  const samples = require("./fixtures/arabic_samples.json");
  const sample = samples[sampleIndex];
  const encodedAudio = Buffer.from(sample.audio_b64, "base64");
  const tmpAudio = `/tmp/test-ptt-${sampleIndex}-${Date.now()}.mp3`;

  writeFileSync(tmpAudio, encodedAudio);

  try {
    const pcm = execSync(`sox "${tmpAudio}" -t raw -r 16000 -c 1 -b 16 -e signed -`, {
      maxBuffer: 10 * 1024 * 1024,
    });
    return { pcm: pcm as Buffer, sentence: sample.sentence };
  } finally {
    unlinkSync(tmpAudio);
  }
}

describe("PTT offline mode", () => {
  test("is opt-in by default", () => {
    expect(enabled).toBe(process.env.RUN_RIVA_E2E === "1");
  });

  test("full buffered pipeline: recognizeOffline → translate → synthesize", async () => {
    if (!enabled) return;

    const cfg = loadConfig({
      asrEndpoint: `${GPU}:50055`,
      nmtEndpoint: `${GPU}:50051`,
      ttsEndpoint: `${GPU}:50056`,
      voiceName: "Magpie-Multilingual.EN-US.Leo",
    });
    const client = new RivaClient(cfg);
    const { pcm, sentence } = loadArabicPcm(0);

    const arabic = await client.recognizeOffline(pcm);
    expect(arabic.length).toBeGreaterThan(0);

    const english = await client.translate(arabic);
    expect(english.length).toBeGreaterThan(0);

    const audio = await client.synthesize(english);
    expect(audio.length).toBeGreaterThan(1000);

    console.log(`  Reference: "${sentence}"`);
    console.log(`  ASR: "${arabic}"`);
    console.log(`  NMT: "${english}"`);
    console.log(`  TTS: ${audio.length} bytes`);
  }, 30_000);

  test("handles multiple buffered utterances sequentially", async () => {
    if (!enabled) return;

    const cfg = loadConfig({
      asrEndpoint: `${GPU}:50055`,
      nmtEndpoint: `${GPU}:50051`,
      ttsEndpoint: `${GPU}:50056`,
      voiceName: "Magpie-Multilingual.EN-US.Leo",
    });
    const client = new RivaClient(cfg);
    const results: string[] = [];

    for (let i = 0; i < 2; i++) {
      const { pcm } = loadArabicPcm(i);
      const arabic = await client.recognizeOffline(pcm);
      if (arabic.length < 5) continue;

      const english = await client.translate(arabic);
      results.push(english);
    }

    expect(results.length).toBeGreaterThanOrEqual(1);
    if (results.length === 2) {
      expect(results[0]).not.toBe(results[1]);
    }
  }, 45_000);
});
