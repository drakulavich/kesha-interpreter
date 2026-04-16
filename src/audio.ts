/**
 * Microphone capture and speaker playback.
 *
 * We use `mic` (sox/arecord/parec shim) for capture because it works on both
 * macOS and Linux without native builds, and `speaker` for playback because it
 * accepts raw PCM frames directly (matches what Riva TTS returns).
 *
 * Everything here is PCM16 LE mono — that's what Riva ASR wants and what Riva
 * TTS emits.
 */
import mic from "mic";
import Speaker from "speaker";
import { PassThrough, type Readable } from "node:stream";

export interface MicHandle {
  /** Readable stream of raw PCM16 LE mono frames at `sampleRate`. */
  readonly stream: Readable;
  start(): void;
  stop(): void;
}

export function openMic(sampleRate: number): MicHandle {
  const instance = mic({
    rate: String(sampleRate),
    channels: "1",
    bitwidth: "16",
    encoding: "signed-integer",
    endian: "little",
    device: process.env.MIC_DEVICE, // optional override
    debug: false,
    // sox is the friendliest cross-platform backend.
    fileType: "raw",
  });
  const stream = instance.getAudioStream();

  // Swallow the spurious stderr noise that `sox` loves to produce when the
  // input device changes sample rate mid-session.
  stream.on("error", () => {});

  return {
    stream,
    start: () => instance.start(),
    stop: () => instance.stop(),
  };
}

export class Player {
  private speaker: Speaker;
  private pipe: PassThrough;

  constructor(sampleRate: number) {
    this.speaker = new Speaker({
      channels: 1,
      bitDepth: 16,
      sampleRate,
      signed: true,
    });
    this.pipe = new PassThrough();
    this.pipe.pipe(this.speaker);
  }

  /** Enqueue a PCM16 LE mono chunk for playback. Non-blocking. */
  write(chunk: Buffer): void {
    this.pipe.write(chunk);
  }

  /** Flush any queued audio and close the speaker. */
  close(): void {
    try {
      this.pipe.end();
    } catch {
      /* ignore */
    }
  }
}
