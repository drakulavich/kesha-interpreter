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
  private proc: ChildProcess | null = null;
  private readonly sampleRate: number;
  private readonly speed: number;

  constructor(sampleRate: number, speed = 1.3) {
    this.sampleRate = sampleRate;
    this.speed = speed;
  }

  write(chunk: Buffer): void {
    if (!this.proc) {
      // Play at higher sample rate to speed up speech (e.g., 1.3x)
      const playRate = Math.round(this.sampleRate * this.speed);
      this.proc = spawn("play", [
        "-q", "-t", "raw", "-r", String(playRate),
        "-b", "16", "-c", "1", "-e", "signed-integer", "-",
      ], { stdio: ["pipe", "ignore", "ignore"] });
      this.proc.on("close", () => { this.proc = null; });
    }
    if (this.proc?.stdin?.writable) {
      this.proc.stdin.write(chunk);
    }
  }

  close(): void {
    try { this.proc?.stdin?.end(); } catch {}
  }
}
