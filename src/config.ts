/** Runtime configuration. Defaults are overridden by CLI args and env vars. */
export interface Config {
  asrEndpoint: string;
  nmtEndpoint: string;
  ttsEndpoint: string;
  tls: boolean;
  apiKey?: string;

  sourceLang: string;   // BCP-47, e.g. "ar-AR"
  targetLang: string;   // BCP-47, e.g. "en-US"
  voiceName: string;    // Magpie voice, e.g. "Magpie-Multilingual.EN-US.Sofia"

  inputSampleRate: number;
  outputSampleRate: number;

  vadAggressiveness: 0 | 1 | 2 | 3;
  silenceMsToFlush: number;
  maxSegmentMs: number;

  verbose: boolean;
}

export function loadConfig(overrides: Partial<Config> = {}): Config {
  const defaults: Config = {
    asrEndpoint: process.env.RIVA_ASR_ENDPOINT ?? "localhost:50055",
    nmtEndpoint: process.env.RIVA_NMT_ENDPOINT ?? "localhost:50051",
    ttsEndpoint: process.env.RIVA_TTS_ENDPOINT ?? "localhost:50056",
    tls: process.env.RIVA_TLS === "1",
    apiKey: process.env.RIVA_API_KEY,

    sourceLang: "ar-AR",
    targetLang: "en-US",
    voiceName: "Magpie-Multilingual.EN-US.Leo",

    inputSampleRate: Number(process.env.INPUT_SAMPLE_RATE ?? 16000),
    outputSampleRate: Number(process.env.OUTPUT_SAMPLE_RATE ?? 22050),

    vadAggressiveness: 1,
    silenceMsToFlush: 2000,
    maxSegmentMs: 15000,

    verbose: false,
  };
  return { ...defaults, ...overrides };
}
