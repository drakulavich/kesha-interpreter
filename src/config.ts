/**
 * Runtime configuration. Most fields can be overridden via CLI flags or env vars.
 *
 * Env vars honored:
 *   RIVA_ENDPOINT        host:port of the Riva NMT NIM (gRPC)                 (default: localhost:50051)
 *   RIVA_TLS             "1" to use SSL credentials                            (default: 0 / insecure)
 *   RIVA_API_KEY         NGC/API key if the endpoint requires auth             (optional)
 *   INPUT_SAMPLE_RATE    mic sample rate in Hz                                 (default: 16000)
 *   OUTPUT_SAMPLE_RATE   TTS output sample rate in Hz                          (default: 44100)
 */
export interface Config {
  endpoint: string;
  tls: boolean;
  apiKey?: string;

  sourceLang: string; // BCP-47, e.g. "ar-AR"
  targetLang: string; // BCP-47, e.g. "en-US"
  voiceName: string;  // Riva TTS voice, e.g. "English-US.Female-1"

  s2sModel: string;   // Riva S2S model name; "s2s_model" is the Riva default

  inputSampleRate: number;   // mic SR (Hz) — 16 kHz is standard for Riva ASR
  outputSampleRate: number;  // TTS SR (Hz)

  // VAD / chunking knobs (only used in --live mode)
  vadAggressiveness: 0 | 1 | 2 | 3; // 0=permissive, 3=strict
  silenceMsToFlush: number;         // ms of trailing silence to flush a segment
  maxSegmentMs: number;             // hard cap per segment

  interimResults: boolean; // print partial (pre-finalized) translations
  verbose: boolean;
}

export function loadConfig(overrides: Partial<Config> = {}): Config {
  const defaults: Config = {
    endpoint: process.env.RIVA_ENDPOINT ?? "localhost:50051",
    tls: process.env.RIVA_TLS === "1",
    apiKey: process.env.RIVA_API_KEY,

    sourceLang: "ar-AR",
    targetLang: "en-US",
    voiceName: "English-US.Female-1",

    s2sModel: "s2s_model",

    inputSampleRate: Number(process.env.INPUT_SAMPLE_RATE ?? 16000),
    outputSampleRate: Number(process.env.OUTPUT_SAMPLE_RATE ?? 44100),

    vadAggressiveness: 2,
    silenceMsToFlush: 600,
    maxSegmentMs: 8000,

    interimResults: true,
    verbose: false,
  };
  return { ...defaults, ...overrides };
}
