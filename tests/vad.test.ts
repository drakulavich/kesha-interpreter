/**
 * VAD state-machine unit tests.
 *
 * Frame geometry (aggressiveness 2, threshold RMS > 800):
 *   sampleRate = 16 000 Hz, FRAME_MS = 20 ms
 *   frameSize  = 16000 * 20 * 2 / 1000 = 640 bytes  (320 int16 samples)
 *
 * VOICED_TRIGGER_FRAMES = 3  (defined in vad.ts)
 *
 * Synthetic frames:
 *   voicedFrame(amplitude)  — all samples set to `amplitude`; RMS == amplitude
 *   silentFrame()           — all samples zero; RMS == 0
 */

import { describe, expect, test } from "bun:test";
import { VadSegmenter } from "../src/vad.ts";

// ─── helpers ─────────────────────────────────────────────────────────────────

const SAMPLE_RATE = 16_000;
const FRAME_MS = 20;
const FRAME_SIZE = (SAMPLE_RATE * FRAME_MS * 2) / 1000; // 640 bytes

/**
 * Returns a frame where every int16 sample equals `amplitude`.
 * RMS of a constant signal equals the constant, so this gives predictable energy.
 */
function voicedFrame(amplitude = 4_000): Buffer {
  const frame = Buffer.alloc(FRAME_SIZE);
  for (let i = 0; i < FRAME_SIZE; i += 2) {
    frame.writeInt16LE(amplitude, i);
  }
  return frame;
}

/** Returns a frame where every sample is zero (RMS == 0). */
function silentFrame(): Buffer {
  return Buffer.alloc(FRAME_SIZE, 0);
}

/** Feed N copies of a frame into the VAD. */
function feedN(vad: VadSegmenter, frame: Buffer, n: number): void {
  for (let i = 0; i < n; i++) vad.feed(frame);
}

/** Build a fresh VAD with aggressiveness 2 (threshold RMS > 800). */
function makeVad(overrides: Partial<{ silenceMsToFlush: number; maxSegmentMs: number }> = {}): VadSegmenter {
  return new VadSegmenter({
    sampleRate: SAMPLE_RATE,
    aggressiveness: 2,
    silenceMsToFlush: overrides.silenceMsToFlush ?? 200,
    maxSegmentMs: overrides.maxSegmentMs ?? 10_000,
  });
}

// ─── segmentStart ─────────────────────────────────────────────────────────────

describe("VadSegmenter — segmentStart", () => {
  test("emits segmentStart after exactly 3 consecutive voiced frames", () => {
    const vad = makeVad();
    let starts = 0;
    vad.events.on("segmentStart", () => { starts++; });

    feedN(vad, voicedFrame(), 3);

    expect(starts).toBe(1);
  });

  test("does not emit segmentStart after only 2 voiced frames", () => {
    const vad = makeVad();
    let starts = 0;
    vad.events.on("segmentStart", () => { starts++; });

    feedN(vad, voicedFrame(), 2);

    expect(starts).toBe(0);
  });

  test("does not emit segmentStart for silent frames", () => {
    const vad = makeVad();
    let starts = 0;
    vad.events.on("segmentStart", () => { starts++; });

    feedN(vad, silentFrame(), 10);

    expect(starts).toBe(0);
  });

  test("resets voiced run when a silent frame interrupts before the trigger", () => {
    const vad = makeVad();
    let starts = 0;
    vad.events.on("segmentStart", () => { starts++; });

    // 2 voiced → 1 silent → 2 voiced: total voiced run never reaches 3
    feedN(vad, voicedFrame(), 2);
    vad.feed(silentFrame());
    feedN(vad, voicedFrame(), 2);

    expect(starts).toBe(0);
  });

  test("emits only one segmentStart per segment even when more voiced frames arrive", () => {
    const vad = makeVad();
    let starts = 0;
    vad.events.on("segmentStart", () => { starts++; });

    feedN(vad, voicedFrame(), 10);

    expect(starts).toBe(1);
  });
});

// ─── frame forwarding ─────────────────────────────────────────────────────────

describe("VadSegmenter — frame forwarding", () => {
  test("replays all 3 trigger frames immediately after segmentStart", () => {
    const vad = makeVad();
    const frames: Buffer[] = [];
    vad.events.on("frame", (f: Buffer) => frames.push(Buffer.from(f)));

    feedN(vad, voicedFrame(), 3);

    // All 3 trigger frames should have been replayed
    expect(frames).toHaveLength(3);
    expect(frames.every(f => f.equals(voicedFrame()))).toBe(true);
  });

  test("does not emit frame events before segmentStart fires", () => {
    const vad = makeVad();
    const frames: Buffer[] = [];
    vad.events.on("frame", (f: Buffer) => frames.push(f));

    feedN(vad, voicedFrame(), 2); // 1 below trigger threshold

    expect(frames).toHaveLength(0);
  });

  test("emits frame for each voiced frame that arrives during an active segment", () => {
    const vad = makeVad();
    const frames: Buffer[] = [];
    vad.events.on("frame", (f: Buffer) => frames.push(Buffer.from(f)));

    feedN(vad, voicedFrame(), 3); // trigger (3 frames replayed)
    feedN(vad, voicedFrame(), 5); // 5 more inside segment

    expect(frames).toHaveLength(8);
  });

  test("emits frame for silent frames that arrive inside an active segment", () => {
    const vad = makeVad({ silenceMsToFlush: 10_000 });
    const frames: Buffer[] = [];
    vad.events.on("frame", (f: Buffer) => frames.push(Buffer.from(f)));

    feedN(vad, voicedFrame(), 3); // trigger
    feedN(vad, silentFrame(), 3); // silent inside segment

    expect(frames).toHaveLength(6);
  });
});

// ─── segmentEnd via silence ───────────────────────────────────────────────────

describe("VadSegmenter — segmentEnd via silence", () => {
  test("emits segmentEnd after silence accumulates to silenceMsToFlush", () => {
    // silenceMsToFlush = 200 ms → 10 silent frames of 20 ms each
    const vad = makeVad({ silenceMsToFlush: 200 });
    let ends = 0;
    vad.events.on("segmentEnd", () => { ends++; });

    feedN(vad, voicedFrame(), 3);   // open segment
    feedN(vad, silentFrame(), 10);  // exactly 200 ms of silence

    expect(ends).toBe(1);
  });

  test("does not emit segmentEnd when silence is below threshold", () => {
    const vad = makeVad({ silenceMsToFlush: 200 });
    let ends = 0;
    vad.events.on("segmentEnd", () => { ends++; });

    feedN(vad, voicedFrame(), 3);  // open segment
    feedN(vad, silentFrame(), 9);  // 180 ms — still 20 ms short

    expect(ends).toBe(0);
  });

  test("voiced frame inside segment resets the silence counter", () => {
    // 4 silent (80 ms) → 1 voiced → 4 silent (80 ms) = total never reaches 200 ms
    const vad = makeVad({ silenceMsToFlush: 200 });
    let ends = 0;
    vad.events.on("segmentEnd", () => { ends++; });

    feedN(vad, voicedFrame(), 3);  // open segment
    feedN(vad, silentFrame(), 4);  // 80 ms silence
    vad.feed(voicedFrame());       // reset silence counter
    feedN(vad, silentFrame(), 4);  // 80 ms silence — still below 200 ms

    expect(ends).toBe(0);
  });

  test("emits segmentEnd only once per segment", () => {
    const vad = makeVad({ silenceMsToFlush: 200 });
    let ends = 0;
    vad.events.on("segmentEnd", () => { ends++; });

    feedN(vad, voicedFrame(), 3);   // open segment
    feedN(vad, silentFrame(), 20);  // 400 ms — well past threshold

    expect(ends).toBe(1);
  });
});

// ─── segmentEnd via maxSegmentMs ─────────────────────────────────────────────

describe("VadSegmenter — segmentEnd via maxSegmentMs", () => {
  test("force-closes the segment when maxSegmentMs is reached", () => {
    // maxSegmentMs = 200 ms → 10 frames of 20 ms each
    const vad = makeVad({ maxSegmentMs: 200, silenceMsToFlush: 10_000 });
    let ends = 0;
    vad.events.on("segmentEnd", () => { ends++; });

    // 3 trigger frames open the segment (segmentMs = 60 ms after emit)
    // then 7 more voiced frames bring segmentMs to 200 ms
    feedN(vad, voicedFrame(), 10);

    expect(ends).toBe(1);
  });

  test("does not emit segmentEnd before maxSegmentMs is reached", () => {
    const vad = makeVad({ maxSegmentMs: 200, silenceMsToFlush: 10_000 });
    let ends = 0;
    vad.events.on("segmentEnd", () => { ends++; });

    feedN(vad, voicedFrame(), 9); // 9 frames = 180 ms — 1 frame short

    expect(ends).toBe(0);
  });
});

// ─── flush() ─────────────────────────────────────────────────────────────────

describe("VadSegmenter — flush()", () => {
  test("emits segmentEnd immediately when a segment is active", () => {
    const vad = makeVad();
    let ends = 0;
    vad.events.on("segmentEnd", () => { ends++; });

    feedN(vad, voicedFrame(), 3); // open segment
    vad.flush();

    expect(ends).toBe(1);
  });

  test("does not emit segmentEnd when no segment is active", () => {
    const vad = makeVad();
    let ends = 0;
    vad.events.on("segmentEnd", () => { ends++; });

    vad.flush(); // called with no active segment

    expect(ends).toBe(0);
  });

  test("calling flush() twice emits segmentEnd only once", () => {
    const vad = makeVad();
    let ends = 0;
    vad.events.on("segmentEnd", () => { ends++; });

    feedN(vad, voicedFrame(), 3);
    vad.flush();
    vad.flush(); // second call — segment already closed

    expect(ends).toBe(1);
  });

  test("a new segment can open after flush() closes the previous one", () => {
    const vad = makeVad();
    let starts = 0;
    let ends = 0;
    vad.events.on("segmentStart", () => { starts++; });
    vad.events.on("segmentEnd", () => { ends++; });

    feedN(vad, voicedFrame(), 3); // first segment
    vad.flush();                  // close it
    feedN(vad, voicedFrame(), 3); // second segment

    expect(starts).toBe(2);
    expect(ends).toBe(1);
  });
});

// ─── frame buffering (feed with oversized chunks) ────────────────────────────

describe("VadSegmenter — feed() with multi-frame chunks", () => {
  test("correctly processes a buffer containing multiple frames at once", () => {
    const vad = makeVad();
    let starts = 0;
    vad.events.on("segmentStart", () => { starts++; });

    // Concatenate 3 voiced frames into one large buffer and feed at once
    const bigChunk = Buffer.concat([voicedFrame(), voicedFrame(), voicedFrame()]);
    vad.feed(bigChunk);

    expect(starts).toBe(1);
  });

  test("handles partial frames that span two feed() calls", () => {
    const vad = makeVad();
    let starts = 0;
    vad.events.on("segmentStart", () => { starts++; });

    const full = Buffer.concat([voicedFrame(), voicedFrame(), voicedFrame()]);

    // Split the first frame across two calls
    const half = FRAME_SIZE / 2;
    vad.feed(full.subarray(0, half));
    vad.feed(full.subarray(half));

    expect(starts).toBe(1);
  });
});

// ─── energy threshold per aggressiveness level ────────────────────────────────

describe("VadSegmenter — aggressiveness thresholds", () => {
  test("aggressiveness 0 (threshold 200) treats amplitude 300 as voice", () => {
    const vad = new VadSegmenter({
      sampleRate: SAMPLE_RATE,
      aggressiveness: 0,
      silenceMsToFlush: 200,
      maxSegmentMs: 10_000,
    });
    let starts = 0;
    vad.events.on("segmentStart", () => { starts++; });

    feedN(vad, voicedFrame(300), 3); // RMS 300 > threshold 200

    expect(starts).toBe(1);
  });

  test("aggressiveness 3 (threshold 1500) treats amplitude 1000 as silence", () => {
    const vad = new VadSegmenter({
      sampleRate: SAMPLE_RATE,
      aggressiveness: 3,
      silenceMsToFlush: 200,
      maxSegmentMs: 10_000,
    });
    let starts = 0;
    vad.events.on("segmentStart", () => { starts++; });

    feedN(vad, voicedFrame(1000), 10); // RMS 1000 < threshold 1500

    expect(starts).toBe(0);
  });

  test("aggressiveness 3 (threshold 1500) triggers on amplitude 2000", () => {
    const vad = new VadSegmenter({
      sampleRate: SAMPLE_RATE,
      aggressiveness: 3,
      silenceMsToFlush: 200,
      maxSegmentMs: 10_000,
    });
    let starts = 0;
    vad.events.on("segmentStart", () => { starts++; });

    feedN(vad, voicedFrame(2000), 3); // RMS 2000 > threshold 1500

    expect(starts).toBe(1);
  });
});
