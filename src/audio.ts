/**
 * Mic capture + speaker playback via sox subprocesses.
 * Requires sox: `brew install sox` / `apt install sox`
 */

import { spawn, type ChildProcess } from "child_process";
import type { Readable } from "node:stream";

export interface MicHandle {
  readonly stream: Readable;
  stop(): void;
}

export function openMic(sampleRate: number): MicHandle {
  const proc = spawn("rec", [
    "-q", "-t", "raw", "-r", String(sampleRate),
    "-c", "1", "-b", "16", "-e", "signed", "-",
  ], { stdio: ["pipe", "pipe", "ignore"] });

  return {
    stream: proc.stdout!,
    stop() { proc.kill("SIGTERM"); },
  };
}

export class Player {
  private pending: Buffer[] = [];
  private readonly sampleRate: number;

  constructor(sampleRate: number) {
    this.sampleRate = sampleRate;
  }

  write(chunk: Buffer): void {
    this.pending.push(chunk);
  }

  /** Flush buffered audio — save as WAV and play with afplay. */
  flush(): void {
    if (this.pending.length === 0) return;
    const pcm = Buffer.concat(this.pending);
    this.pending = [];
    if (pcm.length === 0) return;

    // Build WAV
    const h = Buffer.alloc(44);
    h.write("RIFF", 0); h.writeUInt32LE(36 + pcm.length, 4);
    h.write("WAVE", 8); h.write("fmt ", 12); h.writeUInt32LE(16, 16);
    h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
    h.writeUInt32LE(this.sampleRate, 24); h.writeUInt32LE(this.sampleRate * 2, 28);
    h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
    h.write("data", 36); h.writeUInt32LE(pcm.length, 40);

    const tmpFile = `/tmp/ar-en-simul-${Date.now()}.wav`;
    const fs = require("fs");
    fs.writeFileSync(tmpFile, Buffer.concat([h, pcm]));

    // afplay works alongside rec (separate CoreAudio streams)
    const p = spawn("afplay", [tmpFile], { stdio: "ignore" });
    p.on("close", () => { try { fs.unlinkSync(tmpFile); } catch {} });
  }

  close(): void {
    this.flush();
  }
}
