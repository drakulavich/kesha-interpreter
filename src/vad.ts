/**
 * Lightweight VAD-driven segmenter for --live mode.
 *
 * We slice the mic stream into 20-ms frames (webrtcvad-compatible), run each
 * frame through node-vad, and emit segment boundaries. The caller decides how
 * to react to boundaries (typically: close the current Riva RPC and open a new
 * one, so each utterance gets its own EOS and the server can flush TTS).
 *
 * The state machine is intentionally simple:
 *   - Need N consecutive VOICED frames to open a segment
 *   - Need `silenceMsToFlush` ms of UNVOICED frames to close a segment
 *   - Force-close after `maxSegmentMs` to bound latency on long monologues
 */
import VAD from "node-vad";
import { EventEmitter } from "node:events";

const FRAME_MS = 20; // webrtcvad supports 10/20/30; 20 is a good sweet spot
const VOICED_TRIGGER_FRAMES = 3; // ~60 ms of speech to open

export interface VadOptions {
  sampleRate: number;
  aggressiveness: 0 | 1 | 2 | 3;
  silenceMsToFlush: number;
  maxSegmentMs: number;
}

export class VadSegmenter {
  readonly events = new EventEmitter(); // "segmentStart", "frame"(Buffer), "segmentEnd"

  private vad: any;
  private opts: VadOptions;
  private framesize: number; // bytes per 20-ms frame
  private buf: Buffer = Buffer.alloc(0);

  private inSegment = false;
  private voicedRun = 0;
  private silentMsRun = 0;
  private segmentMs = 0;

  constructor(opts: VadOptions) {
    this.opts = opts;
    this.vad = new VAD(this.mapAggressiveness(opts.aggressiveness));
    // Frame size in bytes = sampleRate * FRAME_MS/1000 * 2 (16-bit mono)
    this.framesize = (opts.sampleRate * FRAME_MS * 2) / 1000;
  }

  private mapAggressiveness(a: number) {
    switch (a) {
      case 0: return VAD.Mode.NORMAL;
      case 1: return VAD.Mode.LOW_BITRATE;
      case 2: return VAD.Mode.AGGRESSIVE;
      case 3: return VAD.Mode.VERY_AGGRESSIVE;
      default: return VAD.Mode.AGGRESSIVE;
    }
  }

  /** Feed raw mic bytes. The segmenter will slice into frames internally. */
  feed(chunk: Buffer): void {
    this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk]);

    while (this.buf.length >= this.framesize) {
      const frame = this.buf.subarray(0, this.framesize);
      this.buf = this.buf.subarray(this.framesize);
      void this.processFrame(frame);
    }
  }

  private async processFrame(frame: Buffer) {
    let isVoice = false;
    try {
      const res: number = await this.vad.processAudio(frame, this.opts.sampleRate);
      // node-vad returns VAD.Event values; VOICE == 2.
      isVoice = res === VAD.Event.VOICE;
    } catch {
      // If VAD hiccups, treat as silence — safer than false-positive triggering.
      isVoice = false;
    }

    if (this.inSegment) {
      this.events.emit("frame", frame);
      this.segmentMs += FRAME_MS;

      if (isVoice) {
        this.silentMsRun = 0;
      } else {
        this.silentMsRun += FRAME_MS;
      }

      const shouldClose =
        this.silentMsRun >= this.opts.silenceMsToFlush ||
        this.segmentMs >= this.opts.maxSegmentMs;

      if (shouldClose) {
        this.inSegment = false;
        this.voicedRun = 0;
        this.silentMsRun = 0;
        this.segmentMs = 0;
        this.events.emit("segmentEnd");
      }
    } else {
      if (isVoice) {
        this.voicedRun += 1;
        if (this.voicedRun >= VOICED_TRIGGER_FRAMES) {
          this.inSegment = true;
          this.silentMsRun = 0;
          this.segmentMs = FRAME_MS * this.voicedRun;
          this.events.emit("segmentStart");
          // Emit the buffered voiced frame too, otherwise we'd clip the onset.
          this.events.emit("frame", frame);
        }
      } else {
        this.voicedRun = 0;
      }
    }
  }

  /** Force-close any open segment (e.g. user hit Ctrl+C). */
  flush(): void {
    if (this.inSegment) {
      this.inSegment = false;
      this.voicedRun = 0;
      this.silentMsRun = 0;
      this.segmentMs = 0;
      this.events.emit("segmentEnd");
    }
  }
}
