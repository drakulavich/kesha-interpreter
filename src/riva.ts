/**
 * 3-hop gRPC pipeline: ASR (streaming) → NMT (unary) → TTS (unary/streaming)
 *
 * Each service runs in its own NIM container:
 *   - ASR: Parakeet 1.1B multilingual (streaming, returns partials)
 *   - NMT: Riva Translate 1.6B (unary, ar → en)
 *   - TTS: Magpie TTS multilingual (unary, returns PCM audio)
 *
 * The S2SSession interface stays the same as the old single-call approach,
 * so modes.ts doesn't need to change.
 */

import * as grpc from "@grpc/grpc-js";
import protoLoader from "@grpc/proto-loader";
import { EventEmitter } from "node:events";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Config } from "./config.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROTO_DIR = path.resolve(__dirname, "..", "protos");

const ENC_LINEAR_PCM = 1;

const GRPC_OPTS = {
  "grpc.max_receive_message_length": 64 * 1024 * 1024,
  "grpc.max_send_message_length": 64 * 1024 * 1024,
  "grpc.keepalive_time_ms": 30_000,
  "grpc.keepalive_timeout_ms": 10_000,
  "grpc.keepalive_permit_without_calls": 1,
};

export interface S2SSession {
  sendAudio(chunk: Buffer): void;
  end(): void;
  close(): void;
  events: EventEmitter;
}

export class RivaClient {
  private readonly asrStub: any;
  private readonly nmtStub: any;
  private readonly ttsStub: any;
  private readonly cfg: Config;

  constructor(cfg: Config) {
    this.cfg = cfg;
    const creds = this.buildCredentials();

    // Load ASR proto
    const asrPkg = protoLoader.loadSync(
      path.join(PROTO_DIR, "riva_asr.proto"),
      { keepCase: false, longs: String, enums: Number, defaults: true, oneofs: true, includeDirs: [PROTO_DIR] },
    );
    const asrProto = grpc.loadPackageDefinition(asrPkg) as any;
    this.asrStub = new asrProto.nvidia.riva.asr.RivaSpeechRecognition(cfg.asrEndpoint, creds, GRPC_OPTS);

    // Load NMT proto
    const nmtPkg = protoLoader.loadSync(
      path.join(PROTO_DIR, "riva_nmt.proto"),
      { keepCase: false, longs: String, enums: Number, defaults: true, oneofs: true, includeDirs: [PROTO_DIR] },
    );
    const nmtProto = grpc.loadPackageDefinition(nmtPkg) as any;
    this.nmtStub = new nmtProto.nvidia.riva.nmt.RivaTranslation(cfg.nmtEndpoint, creds, GRPC_OPTS);

    // Load TTS proto
    const ttsPkg = protoLoader.loadSync(
      path.join(PROTO_DIR, "riva_tts.proto"),
      { keepCase: false, longs: String, enums: Number, defaults: true, oneofs: true, includeDirs: [PROTO_DIR] },
    );
    const ttsProto = grpc.loadPackageDefinition(ttsPkg) as any;
    this.ttsStub = new ttsProto.nvidia.riva.tts.RivaSpeechSynthesis(cfg.ttsEndpoint, creds, GRPC_OPTS);
  }

  private buildCredentials(): grpc.ChannelCredentials {
    const base = this.cfg.tls ? grpc.credentials.createSsl() : grpc.credentials.createInsecure();
    if (!this.cfg.apiKey) return base;
    const callCreds = grpc.credentials.createFromMetadataGenerator((_p, cb) => {
      const md = new grpc.Metadata();
      md.add("authorization", `Bearer ${this.cfg.apiKey}`);
      cb(null, md);
    });
    return grpc.credentials.combineChannelCredentials(base, callCreds);
  }

  /**
   * Open a 3-hop session: ASR streaming → NMT → TTS.
   *
   * Audio chunks go to ASR. When ASR stream ends, the last transcript
   * is translated via NMT, then synthesized via TTS. Audio chunks
   * from TTS are emitted on the "audio" event.
   */
  openS2S(): S2SSession {
    const events = new EventEmitter();
    const cfg = this.cfg;

    // Step 1: Open ASR streaming call
    const asrCall = this.asrStub.StreamingRecognize();

    // Send ASR config
    asrCall.write({
      streamingConfig: {
        config: {
          encoding: ENC_LINEAR_PCM,
          sampleRateHertz: cfg.inputSampleRate,
          languageCode: cfg.sourceLang,
          audioChannelCount: 1,
          enableAutomaticPunctuation: true,
        },
        interimResults: true,
      },
    });

    let lastTranscript = "";
    let ended = false;

    // Collect ASR partials, track last transcript
    asrCall.on("data", (msg: any) => {
      for (const result of msg?.results ?? []) {
        const text = result?.alternatives?.[0]?.transcript ?? "";
        if (text) {
          lastTranscript = text;
          events.emit("partial", text);
        }
      }
    });

    asrCall.on("error", (err: Error) => events.emit("error", err));

    // When ASR stream ends, run NMT → TTS
    asrCall.on("end", () => {
      if (!lastTranscript) {
        events.emit("utteranceEnd");
        events.emit("end");
        return;
      }

      const arabic = lastTranscript;
      events.emit("transcript", arabic);

      // Step 2: NMT
      this.nmtStub.TranslateText(
        {
          texts: [arabic],
          sourceLanguage: cfg.sourceLang.split("-")[0], // "ar"
          targetLanguage: cfg.targetLang.split("-")[0], // "en"
        },
        (nmtErr: Error | null, nmtResp: any) => {
          if (nmtErr) {
            events.emit("error", nmtErr);
            events.emit("end");
            return;
          }

          const english = nmtResp?.translations?.[0]?.text ?? "";
          if (!english) {
            events.emit("utteranceEnd");
            events.emit("end");
            return;
          }

          events.emit("translation", english);

          // Step 3: TTS
          this.ttsStub.Synthesize(
            {
              text: english,
              languageCode: cfg.targetLang,
              encoding: ENC_LINEAR_PCM,
              sampleRateHz: cfg.outputSampleRate,
              voiceName: cfg.voiceName,
            },
            (ttsErr: Error | null, ttsResp: any) => {
              if (ttsErr) {
                events.emit("error", ttsErr);
                events.emit("end");
                return;
              }

              const audio = ttsResp?.audio;
              if (audio && audio.length > 0) {
                events.emit("audio", Buffer.from(audio));
              }
              events.emit("utteranceEnd");
              events.emit("end");
            },
          );
        },
      );
    });

    return {
      sendAudio(chunk: Buffer) {
        if (ended) return;
        asrCall.write({ audioContent: chunk });
      },
      end() {
        if (ended) return;
        ended = true;
        asrCall.end();
      },
      close() {
        if (ended) return;
        ended = true;
        try { asrCall.cancel(); } catch {}
      },
      events,
    };
  }
}
