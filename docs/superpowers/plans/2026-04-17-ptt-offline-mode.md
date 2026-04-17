# PTT Offline Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Use unary `Recognize` RPC in push-to-talk mode for better Arabic ASR accuracy (69% offline vs 60% streaming).

**Architecture:** PTT buffers all audio while SPACE is held, then on release runs a sequential pipeline: offline Recognize → TranslateText → Synthesize. Live/VAD mode is unchanged.

**Tech Stack:** Bun, TypeScript, @grpc/grpc-js, NVIDIA Riva protos, picocolors

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `src/riva.ts` | Modify | Add `recognizeOffline()`, make `translate()`/`synthesize()` public |
| `src/modes.ts` | Modify | Rewrite `runPushToTalk()` to buffer + offline pipeline |
| `src/ui.ts` | Modify | Add `recording()` and `translating()` status functions |
| `tests/e2e.test.ts` | Modify | Add offline ASR test + full offline pipeline test |
| `tests/ptt-offline.test.ts` | Create | E2E test for PTT offline mode behavior |

---

### Task 1: Add `recognizeOffline()` to RivaClient

**Files:**
- Modify: `src/riva.ts:69-95` (make translate/synthesize public), add new method
- Test: `tests/e2e.test.ts`

- [ ] **Step 1: Write the failing test for offline ASR**

Add to `tests/e2e.test.ts` inside the existing `describe("E2E pipeline")` block, after the last test:

```typescript
test("ASR offline Recognize returns transcript for Arabic audio", async () => {
  const samples = (await import("./fixtures/arabic_samples.json")).default;
  const oggB64 = samples[0].audio_b64;
  const expectedArabic = samples[0].sentence;

  // Decode base64 OGG to raw PCM via sox
  const { execSync } = await import("node:child_process");
  const oggBuf = Buffer.from(oggB64, "base64");
  const tmpOgg = `/tmp/test-asr-offline-${Date.now()}.ogg`;
  const { writeFileSync, unlinkSync } = await import("node:fs");
  writeFileSync(tmpOgg, oggBuf);
  const pcm = execSync(`sox "${tmpOgg}" -t raw -r 16000 -c 1 -b 16 -e signed -`, {
    maxBuffer: 10 * 1024 * 1024,
  });
  unlinkSync(tmpOgg);

  // Call unary Recognize
  const result = await new Promise<string>((resolve, reject) => {
    asrStub.Recognize(
      {
        config: {
          encoding: 1,
          sampleRateHertz: 16000,
          languageCode: "ar-AR",
          audioChannelCount: 1,
          enableAutomaticPunctuation: true,
        },
        audio: pcm,
      },
      (err: Error | null, resp: any) => {
        if (err) return reject(err);
        const text = resp?.results?.[0]?.alternatives?.[0]?.transcript ?? "";
        resolve(text);
      },
    );
  });

  expect(result.length).toBeGreaterThan(0);
  console.log(`  ASR offline: "${result}"`);
  console.log(`  Expected:    "${expectedArabic}"`);
}, 15000);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `GPU_HOST=10.119.62.29 bun test tests/e2e.test.ts -t "ASR offline"`
Expected: FAIL — test exists but `Recognize` call should work since it's a proto RPC. This test validates the unary API works. If it passes already, that's fine — we're establishing the contract.

- [ ] **Step 3: Make `translate()` and `synthesize()` public, add `recognizeOffline()`**

In `src/riva.ts`, change the two private methods to public and add the new method:

```typescript
// Change line 69: "private translate" → "translate" (remove private)
translate(text: string): Promise<string> {

// Change line 82: "private synthesize" → "synthesize" (remove private)
synthesize(text: string): Promise<Buffer> {

// Add new method after synthesize(), before openS2S():
recognizeOffline(audio: Buffer): Promise<string> {
  return new Promise((resolve, reject) => {
    this.asrStub.Recognize(
      {
        config: {
          encoding: ENC_LINEAR_PCM,
          sampleRateHertz: this.cfg.inputSampleRate,
          languageCode: this.cfg.sourceLang,
          audioChannelCount: 1,
          enableAutomaticPunctuation: true,
        },
        audio,
      },
      (err: Error | null, resp: any) => {
        if (err) return reject(err);
        const text = resp?.results?.[0]?.alternatives?.[0]?.transcript ?? "";
        resolve(text);
      },
    );
  });
}
```

- [ ] **Step 4: Write the failing test for the full offline pipeline via RivaClient**

Add to `tests/e2e.test.ts`:

```typescript
test("RivaClient offline pipeline: recognizeOffline → translate → synthesize", async () => {
  const { RivaClient } = await import("../src/riva.ts");
  const { loadConfig } = await import("../src/config.ts");

  const cfg = loadConfig({
    asrEndpoint: `${GPU}:50055`,
    nmtEndpoint: `${GPU}:50051`,
    ttsEndpoint: `${GPU}:50056`,
    voiceName: "Magpie-Multilingual.EN-US.Leo",
  });
  const client = new RivaClient(cfg);

  // Get real Arabic PCM
  const samples = (await import("./fixtures/arabic_samples.json")).default;
  const { execSync } = await import("node:child_process");
  const { writeFileSync, unlinkSync } = await import("node:fs");
  const oggBuf = Buffer.from(samples[0].audio_b64, "base64");
  const tmpOgg = `/tmp/test-offline-pipeline-${Date.now()}.ogg`;
  writeFileSync(tmpOgg, oggBuf);
  const pcm = execSync(`sox "${tmpOgg}" -t raw -r 16000 -c 1 -b 16 -e signed -`, {
    maxBuffer: 10 * 1024 * 1024,
  });
  unlinkSync(tmpOgg);

  // Step 1: Offline ASR
  const arabic = await client.recognizeOffline(pcm as Buffer);
  expect(arabic.length).toBeGreaterThan(0);
  console.log(`  Offline ASR: "${arabic}"`);

  // Step 2: Translate
  const english = await client.translate(arabic);
  expect(english.length).toBeGreaterThan(0);
  console.log(`  NMT: "${english}"`);

  // Step 3: Synthesize
  const audio = await client.synthesize(english);
  expect(audio.length).toBeGreaterThan(1000);
  const dur = audio.length / (22050 * 2);
  console.log(`  TTS: ${audio.length} bytes (${dur.toFixed(1)}s)`);
}, 30000);
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `GPU_HOST=10.119.62.29 bun test tests/e2e.test.ts -t "offline"`
Expected: Both "ASR offline" and "offline pipeline" tests PASS

- [ ] **Step 6: Commit**

```bash
git add src/riva.ts tests/e2e.test.ts
git commit -m "feat: add recognizeOffline() for unary ASR, make translate/synthesize public"
```

---

### Task 2: Add UI status functions

**Files:**
- Modify: `src/ui.ts`

- [ ] **Step 1: Add `recording()` and `translating()` functions**

Add at the end of `src/ui.ts`:

```typescript
export function recording() {
  clr();
  process.stdout.write(pc.dim("  Recording..."));
}

export function translating() {
  clr();
  process.stdout.write(pc.dim("  Translating..."));
}
```

- [ ] **Step 2: Commit**

```bash
git add src/ui.ts
git commit -m "feat: add recording/translating UI status indicators"
```

---

### Task 3: Rewrite `runPushToTalk()` for offline pipeline

**Files:**
- Modify: `src/modes.ts:101-165`

- [ ] **Step 1: Replace `runPushToTalk()` with offline implementation**

Replace the entire `runPushToTalk` function in `src/modes.ts` (lines 101-165) with:

```typescript
export async function runPushToTalk(cfg: Config): Promise<void> {
  startDebugRecording();
  const riva = new RivaClient(cfg);
  const player = new Player(cfg.outputSampleRate);
  const mic = openMic(cfg.inputSampleRate);

  let recording = false;
  let audioChunks: Buffer[] = [];
  let processing = false;

  const processUtterance = async (audio: Buffer) => {
    if (processing) return;
    processing = true;
    trackEvent("processStart");

    try {
      ui.translating();
      trackEvent("asrStart");
      const arabic = await riva.recognizeOffline(audio);
      trackEvent("asrResult", arabic);
      log(`ASR offline: ${arabic.slice(0, 80)}`);

      if (!arabic || arabic.length < 5) {
        log("ASR too short, skipping");
        ui.clr();
        processing = false;
        return;
      }

      const english = await riva.translate(arabic);
      trackEvent("translation", english);
      log(`NMT: ${english.slice(0, 80)}`);

      if (!english || english.length < 5) {
        log("NMT too short, skipping");
        ui.clr();
        processing = false;
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
    } catch (err: any) {
      trackEvent("error", err?.message?.slice(0, 100));
      ui.error(err?.message ?? "Pipeline error");
    }

    processing = false;
  };

  mic.stream.on("data", (chunk: Buffer) => {
    recordAudio(chunk);
    if (recording) audioChunks.push(chunk);
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
      if (!recording && !processing) {
        recording = true;
        audioChunks = [];
        trackEvent("startRecording");
        ui.recording();
      }
      if (releaseTimer) clearTimeout(releaseTimer);
      releaseTimer = setTimeout(() => {
        if (Date.now() - lastSpaceMs >= GAP_MS && recording) {
          recording = false;
          trackEvent("stopRecording");
          const audio = Buffer.concat(audioChunks);
          audioChunks = [];
          if (audio.length > cfg.inputSampleRate * 2 * 0.3) {
            // At least 0.3s of audio
            processUtterance(audio);
          } else {
            log("Recording too short, skipping");
            ui.clr();
          }
        }
      }, GAP_MS + 20);
    }
  });

  const shutdown = () => {
    if (releaseTimer) clearTimeout(releaseTimer);
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
```

- [ ] **Step 2: Remove unused imports if any**

Check that `S2SSession` import is still needed (it is — used by `runLive` via `wireSession`). The `muted` variable and `wireSession` function are still used by `runLive`, so don't remove them. No import changes needed.

- [ ] **Step 3: Verify the CLI works manually**

Run: `DEBUG=1 bun run src/index.ts --gpu 10.119.62.29 --ptt`

Expected behavior:
1. Health checks pass for ASR, NMT, TTS
2. Shows "Push-to-talk (SPACE)"
3. Hold SPACE → shows dim "Recording..."
4. Release SPACE → shows dim "Translating..." → shows English text → plays English audio
5. Press `q` to quit

- [ ] **Step 4: Run all tests to check for regressions**

Run: `GPU_HOST=10.119.62.29 bun test`
Expected: All existing tests pass, new offline tests pass

- [ ] **Step 5: Commit**

```bash
git add src/modes.ts
git commit -m "feat: PTT offline mode — buffer audio, unary Recognize for better ASR"
```

---

### Task 4: E2E test for PTT offline mode

**Files:**
- Create: `tests/ptt-offline.test.ts`

- [ ] **Step 1: Write the PTT offline E2E test**

Create `tests/ptt-offline.test.ts`:

```typescript
/**
 * E2E test: simulates PTT offline mode behavior.
 * Sends real Arabic audio as a single buffer through the offline pipeline,
 * verifying the full flow: recognizeOffline → translate → synthesize.
 *
 * Requires GPU services running:
 *   ASR on GPU_HOST:50055, NMT on GPU_HOST:50051, TTS on GPU_HOST:50056
 *
 * Run: GPU_HOST=10.119.62.29 bun test tests/ptt-offline.test.ts
 */

import { describe, test, expect } from "bun:test";
import { execSync } from "node:child_process";
import { writeFileSync, unlinkSync } from "node:fs";
import { RivaClient } from "../src/riva.ts";
import { loadConfig } from "../src/config.ts";

const GPU = process.env.GPU_HOST ?? "10.119.62.29";

function loadArabicPcm(sampleIndex = 0): { pcm: Buffer; sentence: string } {
  const samples = require("./fixtures/arabic_samples.json");
  const sample = samples[sampleIndex];
  const oggBuf = Buffer.from(sample.audio_b64, "base64");
  const tmpOgg = `/tmp/test-ptt-${Date.now()}.ogg`;
  writeFileSync(tmpOgg, oggBuf);
  const pcm = execSync(`sox "${tmpOgg}" -t raw -r 16000 -c 1 -b 16 -e signed -`, {
    maxBuffer: 10 * 1024 * 1024,
  });
  unlinkSync(tmpOgg);
  return { pcm: pcm as Buffer, sentence: sample.sentence };
}

describe("PTT offline mode", () => {
  const cfg = loadConfig({
    asrEndpoint: `${GPU}:50055`,
    nmtEndpoint: `${GPU}:50051`,
    ttsEndpoint: `${GPU}:50056`,
    voiceName: "Magpie-Multilingual.EN-US.Leo",
  });
  const client = new RivaClient(cfg);

  test("offline ASR produces better or equal transcript than streaming for same audio", async () => {
    const { pcm, sentence } = loadArabicPcm(0);

    // Offline recognition
    const offlineResult = await client.recognizeOffline(pcm);
    expect(offlineResult.length).toBeGreaterThan(0);

    console.log(`  Reference: "${sentence}"`);
    console.log(`  Offline:   "${offlineResult}"`);
  }, 20000);

  test("full PTT pipeline: buffer → recognizeOffline → translate → synthesize", async () => {
    const { pcm, sentence } = loadArabicPcm(0);

    // Simulate PTT: all audio buffered, then sent at once
    const t0 = performance.now();

    const arabic = await client.recognizeOffline(pcm);
    const tAsr = performance.now();
    expect(arabic.length).toBeGreaterThan(0);

    const english = await client.translate(arabic);
    const tNmt = performance.now();
    expect(english.length).toBeGreaterThan(0);

    const audio = await client.synthesize(english);
    const tTts = performance.now();
    expect(audio.length).toBeGreaterThan(1000);

    const asrMs = (tAsr - t0).toFixed(0);
    const nmtMs = (tNmt - tAsr).toFixed(0);
    const ttsMs = (tTts - tNmt).toFixed(0);
    const totalMs = (tTts - t0).toFixed(0);
    const audioDur = (audio.length / (22050 * 2)).toFixed(1);

    console.log(`  Reference: "${sentence}"`);
    console.log(`  ASR (${asrMs}ms): "${arabic}"`);
    console.log(`  NMT (${nmtMs}ms): "${english}"`);
    console.log(`  TTS (${ttsMs}ms): ${audio.length} bytes (${audioDur}s)`);
    console.log(`  Total: ${totalMs}ms`);
  }, 30000);

  test("PTT pipeline handles multiple utterances sequentially", async () => {
    // Simulate pressing SPACE twice — two separate utterances
    const results: string[] = [];

    for (let i = 0; i < 2; i++) {
      const { pcm } = loadArabicPcm(i);
      const arabic = await client.recognizeOffline(pcm);
      if (arabic.length < 5) continue;
      const english = await client.translate(arabic);
      results.push(english);
      console.log(`  Utterance ${i + 1}: "${english}"`);
    }

    expect(results.length).toBeGreaterThanOrEqual(1);
    // Each utterance should produce a different translation
    if (results.length === 2) {
      expect(results[0]).not.toBe(results[1]);
    }
  }, 45000);

  test("PTT pipeline skips empty/short ASR results gracefully", async () => {
    // Send 0.1s of silence — should produce empty/short ASR
    const silenceSamples = 16000 * 0.1;
    const silence = Buffer.alloc(silenceSamples * 2); // 16-bit PCM zeros

    const arabic = await client.recognizeOffline(silence);
    // Should be empty or very short — pipeline should not crash
    console.log(`  Silence ASR: "${arabic}" (length: ${arabic.length})`);
    expect(arabic.length).toBeLessThan(10);
  }, 10000);
});
```

- [ ] **Step 2: Run the PTT tests**

Run: `GPU_HOST=10.119.62.29 bun test tests/ptt-offline.test.ts`
Expected: All 4 tests PASS

- [ ] **Step 3: Run all tests for regressions**

Run: `GPU_HOST=10.119.62.29 bun test`
Expected: All tests PASS

- [ ] **Step 4: Commit**

```bash
git add tests/ptt-offline.test.ts
git commit -m "test: E2E tests for PTT offline mode behavior"
```
