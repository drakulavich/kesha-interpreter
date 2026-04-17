/**
 * 3-hop gRPC pipeline: ASR (streaming) → NMT (debounced) → TTS (unary)
 *
 * ASR partials → debounced NMT → show partial English text.
 * ASR end → final NMT → TTS Synthesize → audio event.
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

const PROTO_LOADER_OPTS: protoLoader.Options = {
  keepCase: false, longs: String, enums: Number,
  defaults: true, oneofs: true, includeDirs: [PROTO_DIR],
};

const GRPC_OPTS = {
  "grpc.max_receive_message_length": 64 * 1024 * 1024,
  "grpc.max_send_message_length": 64 * 1024 * 1024,
  "grpc.keepalive_time_ms": 30_000,
  "grpc.keepalive_timeout_ms": 10_000,
  "grpc.keepalive_permit_without_calls": 1,
};

function loadStub(proto: string, svcPath: string, endpoint: string, creds: grpc.ChannelCredentials): any {
  const pkg = protoLoader.loadSync(path.join(PROTO_DIR, proto), PROTO_LOADER_OPTS);
  const def = grpc.loadPackageDefinition(pkg) as any;
  return new (svcPath.split(".").reduce((o: any, k: string) => o[k], def))(endpoint, creds, GRPC_OPTS);
}

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
    this.asrStub = loadStub("riva_asr.proto", "nvidia.riva.asr.RivaSpeechRecognition", cfg.asrEndpoint, creds);
    this.nmtStub = loadStub("riva_nmt.proto", "nvidia.riva.nmt.RivaTranslation", cfg.nmtEndpoint, creds);
    this.ttsStub = loadStub("riva_tts.proto", "nvidia.riva.tts.RivaSpeechSynthesis", cfg.ttsEndpoint, creds);
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

  private translate(text: string): Promise<string> {
    return new Promise((resolve, reject) => {
      this.nmtStub.TranslateText(
        {
          texts: [text],
          sourceLanguage: this.cfg.sourceLang.split("-")[0],
          targetLanguage: this.cfg.targetLang.split("-")[0],
        },
        (err: Error | null, resp: any) => {
          if (err) return reject(err);
          resolve(resp?.translations?.[0]?.text ?? "");
        },
      );
    });
  }

  private synthesize(text: string): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      this.ttsStub.Synthesize(
        {
          text,
          languageCode: this.cfg.targetLang,
          encoding: ENC_LINEAR_PCM,
          sampleRateHz: this.cfg.outputSampleRate,
          voiceName: this.cfg.voiceName,
        },
        (err: Error | null, resp: any) => {
          if (err) return reject(err);
          resolve(Buffer.from(resp?.audio ?? []));
        },
      );
    });
  }

  openS2S(): S2SSession {
    const events = new EventEmitter();
    const cfg = this.cfg;

    const asrCall = this.asrStub.StreamingRecognize();
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
    let lastPartialEn = "";
    let partialTimer: ReturnType<typeof setTimeout> | null = null;
    let ended = false;

    // Debounced partial: translate ASR text, show dim English
    const translatePartial = (arabic: string) => {
      if (partialTimer) clearTimeout(partialTimer);
      partialTimer = setTimeout(async () => {
        try {
          const en = await this.translate(arabic);
          if (en && en !== lastPartialEn) {
            lastPartialEn = en;
            events.emit("partialTranslation", en);
          }
        } catch {}
      }, 800);
    };

    asrCall.on("data", (msg: any) => {
      for (const result of msg?.results ?? []) {
        const text = result?.alternatives?.[0]?.transcript ?? "";
        if (text) {
          lastTranscript = text;
          events.emit("partial", text);
          translatePartial(text);
        }
      }
    });

    asrCall.on("error", (err: Error) => events.emit("error", err));

    // ASR done → final NMT → TTS → audio
    asrCall.on("end", async () => {
      if (partialTimer) clearTimeout(partialTimer);

      if (!lastTranscript) {
        events.emit("utteranceEnd");
        events.emit("end");
        return;
      }

      try {
        const english = await this.translate(lastTranscript);
        if (!english) {
          events.emit("utteranceEnd");
          events.emit("end");
          return;
        }

        events.emit("translation", english);

        const audio = await this.synthesize(english);
        if (audio.length > 0) {
          events.emit("audio", audio);
        }
      } catch (err) {
        events.emit("error", err);
      }

      events.emit("utteranceEnd");
      events.emit("end");
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
