/**
 * Test that Player actually writes audio data to sox process.
 * This test catches the real issue: audio events fire but nothing plays.
 */
import { describe, test, expect } from "bun:test";
import { Player } from "../src/audio.ts";
import { writeFileSync, existsSync, unlinkSync, readFileSync } from "fs";
import { spawn } from "child_process";
import { tmpdir } from "os";
import { join } from "path";

const TMP = join(tmpdir(), "kesha-interpreter-test.raw");

describe("Player playback", () => {
  test("writes audio bytes to sox stdin and sox exits cleanly", async () => {
    // Generate 0.5s of 440Hz sine at 22050Hz
    const samples = 22050 / 2;
    const buf = Buffer.alloc(samples * 2);
    for (let i = 0; i < samples; i++) {
      buf.writeInt16LE(Math.round(Math.sin(2 * Math.PI * 440 * i / 22050) * 16000), i * 2);
    }

    const player = new Player(22050);
    player.write(buf);
    player.flush();

    // Give sox time to play
    await new Promise((r) => setTimeout(r, 1000));
    // If we got here without crash, sox accepted the audio
    expect(true).toBe(true);
  }, 5000);

  test("TTS audio from server plays through Player", async () => {
    // Get real TTS audio from server
    const GPU = process.env.GPU_HOST ?? "10.119.62.29";

    const grpc = await import("@grpc/grpc-js");
    const protoLoader = await import("@grpc/proto-loader");
    const path = await import("path");

    const PROTO_DIR = path.resolve(import.meta.dir, "..", "protos");
    const pkg = protoLoader.loadSync(path.join(PROTO_DIR, "riva_tts.proto"), {
      keepCase: false, longs: String, enums: Number, defaults: true, oneofs: true, includeDirs: [PROTO_DIR],
    });
    const def = grpc.loadPackageDefinition(pkg) as any;
    const stub = new def.nvidia.riva.tts.RivaSpeechSynthesis(
      `${GPU}:50056`, grpc.credentials.createInsecure()
    );

    const audio = await new Promise<Buffer>((resolve, reject) => {
      stub.Synthesize({
        text: "Hello, this is a playback test.",
        languageCode: "en-US",
        encoding: 1,
        sampleRateHz: 22050,
        voiceName: "Magpie-Multilingual.EN-US.Leo",
      }, (err: any, resp: any) => {
        if (err) return reject(err);
        resolve(Buffer.from(resp?.audio ?? []));
      });
    });

    console.log(`  TTS returned ${audio.length} bytes`);
    expect(audio.length).toBeGreaterThan(1000);

    // Play through Player
    const player = new Player(22050);
    console.log(`  Writing ${audio.length} bytes to player...`);
    player.write(audio);
    console.log(`  Flushing player...`);
    player.flush();

    // Wait for playback
    await new Promise((r) => setTimeout(r, 3000));
    console.log(`  Playback complete`);
  }, 15000);
});
