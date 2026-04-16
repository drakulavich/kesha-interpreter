/**
 * Thin wrapper around the Riva NMT gRPC service, specifically the
 * `StreamingTranslateSpeechToSpeech` RPC.
 *
 * That RPC takes a bidi stream:
 *   client -> server:  first message is a config; subsequent messages are raw
 *                      PCM audio chunks in the mic's source language
 *   server -> client:  stream of { speech: { audio: <bytes> } } — synthesized
 *                      audio chunks in the target language. The server sends an
 *                      empty buffer to mark end-of-stream for a given utterance.
 *
 * Under the hood the Riva NIM runs a cascade: ASR (Canary / Parakeet) -> NMT
 * -> TTS (FastPitch + HiFi-GAN). Everything stays on the GPU so the extra hops
 * are effectively free.
 */
import * as grpc from "@grpc/grpc-js";
import protoLoader from "@grpc/proto-loader";
import { EventEmitter } from "node:events";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Config } from "./config.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROTO_DIR = path.resolve(__dirname, "..", "protos");

// AudioEncoding enum values from riva_audio.proto
const ENC_LINEAR_PCM = 1;

// The types we actually touch; we keep it loose because proto-loader returns `any`.
type StreamingS2SClient = grpc.Client & {
  StreamingTranslateSpeechToSpeech: () => grpc.ClientDuplexStream<unknown, unknown>;
};

export interface S2SSession {
  /** Send a raw PCM16 mono chunk from the microphone. */
  sendAudio(chunk: Buffer): void;
  /** Signal end-of-utterance. The server finishes any in-flight synthesis. */
  end(): void;
  /** Tear down the whole RPC. */
  close(): void;
  /** EventEmitter: "audio" (Buffer), "end", "error" (Error). */
  events: EventEmitter;
}

export class RivaClient {
  private readonly client: StreamingS2SClient;
  private readonly cfg: Config;

  constructor(cfg: Config) {
    this.cfg = cfg;

    const packageDef = protoLoader.loadSync(
      path.join(PROTO_DIR, "riva_nmt.proto"),
      {
        keepCase: false, // gRPC.js convention: camelCase field names
        longs: String,
        enums: Number,
        defaults: true,
        oneofs: true,
        includeDirs: [path.resolve(PROTO_DIR, "..")], // allow `import "riva/proto/..."`
      },
    );

    const proto = grpc.loadPackageDefinition(packageDef) as any;
    const RivaTranslation = proto.nvidia.riva.nmt.RivaTranslation;

    const creds = this.buildCredentials();
    this.client = new RivaTranslation(cfg.endpoint, creds, {
      "grpc.max_receive_message_length": 64 * 1024 * 1024,
      "grpc.max_send_message_length": 64 * 1024 * 1024,
      // Keepalive so long conversational sessions don't get dropped by NATs.
      "grpc.keepalive_time_ms": 30_000,
      "grpc.keepalive_timeout_ms": 10_000,
      "grpc.keepalive_permit_without_calls": 1,
    });
  }

  private buildCredentials(): grpc.ChannelCredentials {
    const base = this.cfg.tls
      ? grpc.credentials.createSsl()
      : grpc.credentials.createInsecure();

    if (!this.cfg.apiKey) return base;

    // Attach bearer-style metadata (NGC/NIM accepts "authorization: Bearer <key>").
    const callCreds = grpc.credentials.createFromMetadataGenerator(
      (_params, cb) => {
        const md = new grpc.Metadata();
        md.add("authorization", `Bearer ${this.cfg.apiKey}`);
        cb(null, md);
      },
    );
    return grpc.credentials.combineChannelCredentials(base, callCreds);
  }

  /**
   * Open a new streaming speech-to-speech session. You send PCM16 chunks in,
   * you receive PCM chunks out via the returned EventEmitter.
   */
  openS2S(): S2SSession {
    const events = new EventEmitter();
    const call = this.client.StreamingTranslateSpeechToSpeech();

    // Step 1: send the config message first.
    const configMsg = {
      config: {
        asrConfig: {
          encoding: ENC_LINEAR_PCM,
          sampleRateHertz: this.cfg.inputSampleRate,
          languageCode: this.cfg.sourceLang,
          maxAlternatives: 1,
          enableAutomaticPunctuation: true,
          // Single channel only — Riva requirement.
          audioChannelCount: 1,
        },
        translationConfig: {
          sourceLanguageCode: this.cfg.sourceLang,
          targetLanguageCode: this.cfg.targetLang,
          modelName: this.cfg.s2sModel,
        },
        ttsConfig: {
          encoding: ENC_LINEAR_PCM,
          sampleRateHz: this.cfg.outputSampleRate,
          voiceName: this.cfg.voiceName,
          languageCode: this.cfg.targetLang,
        },
      },
    };
    call.write(configMsg);

    call.on("data", (msg: any) => {
      const audio: Buffer | undefined = msg?.speech?.audio;
      if (audio && audio.length > 0) {
        events.emit("audio", audio);
      } else {
        // Empty buffer == end-of-utterance marker from the server.
        events.emit("utteranceEnd");
      }
    });

    call.on("error", (err: Error) => events.emit("error", err));
    call.on("end", () => events.emit("end"));

    let ended = false;
    return {
      sendAudio(chunk: Buffer) {
        if (ended) return;
        call.write({ audioContent: chunk });
      },
      end() {
        if (ended) return;
        ended = true;
        call.end();
      },
      close() {
        if (ended) return;
        ended = true;
        try {
          call.cancel();
        } catch {
          /* ignore */
        }
      },
      events,
    };
  }
}
