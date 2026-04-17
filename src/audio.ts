/**
 * Mic capture + speaker playback via sox subprocesses.
 * No native deps (no node-gyp for mic/speaker). Works on macOS + Linux.
 * Requires sox: `brew install sox` / `apt install sox`
 */

import { spawn, type ChildProcess } from "child_process";
import type { Readable } from "node:stream";

export interface MicHandle {
  readonly stream: Readable;
  start(): void;
  stop(): void;
}

export function openMic(sampleRate: number): MicHandle {
  const proc = spawn("rec", [
    "-q", "-t", "raw", "-r", String(sampleRate),
    "-c", "1", "-b", "16", "-e", "signed", "-",
  ], { stdio: ["pipe", "pipe", "ignore"] });

  return {
    stream: proc.stdout!,
    start() { /* rec starts on spawn */ },
    stop() { proc.kill("SIGTERM"); },
  };
}

export class Player {
  private proc: ChildProcess | null = null;
  private readonly sampleRate: number;

  constructor(sampleRate: number) {
    this.sampleRate = sampleRate;
  }

  write(chunk: Buffer): void {
    if (!this.proc) {
      this.proc = spawn("play", [
        "-q", "-t", "raw", "-r", String(this.sampleRate),
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
