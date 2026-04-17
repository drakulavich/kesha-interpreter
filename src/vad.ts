/** Energy-based VAD segmenter using RMS energy on 20 ms frames. */

import { EventEmitter } from "node:events";

const FRAME_MS = 20;
const VOICED_TRIGGER_FRAMES = 3;

export interface VadOptions {
  sampleRate: number;
  aggressiveness: 0 | 1 | 2 | 3;
  silenceMsToFlush: number;
  maxSegmentMs: number;
}

// RMS energy thresholds per aggressiveness level (lower = more sensitive)
const THRESHOLDS: Record<number, number> = {
  0: 200,   // permissive — picks up quiet speech
  1: 400,
  2: 800,   // aggressive — needs clear speech
  3: 1500,  // very aggressive — loud speech only
};

export class VadSegmenter {
  readonly events = new EventEmitter();

  private readonly threshold: number;
  private readonly frameSize: number;
  private readonly opts: VadOptions;
  private buf: Buffer = Buffer.alloc(0);

  private inSegment = false;
  private voicedRun = 0;
  private pendingVoicedFrames: Buffer[] = [];
  private silentMsRun = 0;
  private segmentMs = 0;

  constructor(opts: VadOptions) {
    this.opts = opts;
    this.threshold = THRESHOLDS[opts.aggressiveness] ?? THRESHOLDS[2];
    this.frameSize = (opts.sampleRate * FRAME_MS * 2) / 1000; // bytes per frame (16-bit mono)
  }

  feed(chunk: Buffer): void {
    this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk]);

    while (this.buf.length >= this.frameSize) {
      const frame = this.buf.subarray(0, this.frameSize);
      this.buf = this.buf.subarray(this.frameSize);
      this.processFrame(frame);
    }
  }

  private processFrame(frame: Buffer): void {
    const isVoice = rmsEnergy(frame) > this.threshold;

    if (this.inSegment) {
      this.events.emit("frame", frame);
      this.segmentMs += FRAME_MS;

      if (isVoice) {
        this.silentMsRun = 0;
      } else {
        this.silentMsRun += FRAME_MS;
      }

      if (this.silentMsRun >= this.opts.silenceMsToFlush || this.segmentMs >= this.opts.maxSegmentMs) {
        this.inSegment = false;
        this.voicedRun = 0;
        this.silentMsRun = 0;
        this.segmentMs = 0;
        this.events.emit("segmentEnd");
      }
    } else {
      if (isVoice) {
        this.voicedRun++;
        this.pendingVoicedFrames.push(frame);
        if (this.voicedRun >= VOICED_TRIGGER_FRAMES) {
          this.inSegment = true;
          this.silentMsRun = 0;
          this.segmentMs = FRAME_MS * this.pendingVoicedFrames.length;
          this.events.emit("segmentStart");
          for (const bufferedFrame of this.pendingVoicedFrames) {
            this.events.emit("frame", bufferedFrame);
          }
          this.pendingVoicedFrames = [];
        }
      } else {
        this.voicedRun = 0;
        this.pendingVoicedFrames = [];
      }
    }
  }

  flush(): void {
    if (this.inSegment) {
      this.inSegment = false;
      this.voicedRun = 0;
      this.pendingVoicedFrames = [];
      this.silentMsRun = 0;
      this.segmentMs = 0;
      this.events.emit("segmentEnd");
    }
  }
}

function rmsEnergy(frame: Buffer): number {
  let sum = 0;
  const samples = frame.length / 2;
  for (let i = 0; i < frame.length; i += 2) {
    const s = frame.readInt16LE(i);
    sum += s * s;
  }
  return Math.sqrt(sum / samples);
}
