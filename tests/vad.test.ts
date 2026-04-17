import { describe, expect, test } from "bun:test";
import { VadSegmenter } from "../src/vad.ts";

const SAMPLE_RATE = 16_000;
const FRAME_SIZE = (SAMPLE_RATE * 20 * 2) / 1000;

function voicedFrame(amplitude = 4_000): Buffer {
  const frame = Buffer.alloc(FRAME_SIZE);
  for (let i = 0; i < FRAME_SIZE; i += 2) {
    frame.writeInt16LE(amplitude, i);
  }
  return frame;
}

describe("VadSegmenter", () => {
  test("emits the trigger frames that started the segment", () => {
    const vad = new VadSegmenter({
      sampleRate: SAMPLE_RATE,
      aggressiveness: 2,
      silenceMsToFlush: 200,
      maxSegmentMs: 2_000,
    });

    const frames: Buffer[] = [];
    let starts = 0;

    vad.events.on("segmentStart", () => {
      starts += 1;
    });
    vad.events.on("frame", (frame: Buffer) => {
      frames.push(Buffer.from(frame));
    });

    vad.feed(voicedFrame());
    vad.feed(voicedFrame());
    vad.feed(voicedFrame());

    expect(starts).toBe(1);
    expect(frames).toHaveLength(3);
    expect(frames.every((frame) => frame.equals(voicedFrame()))).toBe(true);
  });
});
