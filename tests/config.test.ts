import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { loadConfig } from "../src/config.ts";

// Snapshot original env once; restore after every test.
const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  // Replace the whole env object so deleted keys are also restored.
  for (const key of Object.keys(process.env)) {
    if (!(key in ORIGINAL_ENV)) delete process.env[key];
  }
  Object.assign(process.env, ORIGINAL_ENV);
});

// ─── defaults ────────────────────────────────────────────────────────────────

describe("loadConfig — defaults", () => {
  beforeEach(() => {
    // Remove all Riva-related vars so we always test the hard-coded defaults.
    delete process.env.RIVA_ASR_ENDPOINT;
    delete process.env.RIVA_NMT_ENDPOINT;
    delete process.env.RIVA_TTS_ENDPOINT;
    delete process.env.RIVA_TLS;
    delete process.env.RIVA_API_KEY;
    delete process.env.INPUT_SAMPLE_RATE;
    delete process.env.OUTPUT_SAMPLE_RATE;
  });

  test("returns localhost ASR endpoint when env var is absent", () => {
    const cfg = loadConfig();
    expect(cfg.asrEndpoint).toBe("localhost:50055");
  });

  test("returns localhost NMT endpoint when env var is absent", () => {
    const cfg = loadConfig();
    expect(cfg.nmtEndpoint).toBe("localhost:50051");
  });

  test("returns localhost TTS endpoint when env var is absent", () => {
    const cfg = loadConfig();
    expect(cfg.ttsEndpoint).toBe("localhost:50056");
  });

  test("defaults tls to false when RIVA_TLS is absent", () => {
    const cfg = loadConfig();
    expect(cfg.tls).toBe(false);
  });

  test("defaults apiKey to undefined when RIVA_API_KEY is absent", () => {
    const cfg = loadConfig();
    expect(cfg.apiKey).toBeUndefined();
  });

  test("defaults sourceLang to ar-AR", () => {
    expect(loadConfig().sourceLang).toBe("ar-AR");
  });

  test("defaults targetLang to en-US", () => {
    expect(loadConfig().targetLang).toBe("en-US");
  });

  test("defaults voiceName to Magpie-Multilingual.EN-US.Leo", () => {
    expect(loadConfig().voiceName).toBe("Magpie-Multilingual.EN-US.Leo");
  });

  test("defaults inputSampleRate to 16000 when env var is absent", () => {
    expect(loadConfig().inputSampleRate).toBe(16_000);
  });

  test("defaults outputSampleRate to 22050 when env var is absent", () => {
    expect(loadConfig().outputSampleRate).toBe(22_050);
  });

  test("defaults vadAggressiveness to 1", () => {
    expect(loadConfig().vadAggressiveness).toBe(1);
  });

  test("defaults silenceMsToFlush to 1500", () => {
    expect(loadConfig().silenceMsToFlush).toBe(1_500);
  });

  test("defaults maxSegmentMs to 15000", () => {
    expect(loadConfig().maxSegmentMs).toBe(15_000);
  });

  test("defaults verbose to false", () => {
    expect(loadConfig().verbose).toBe(false);
  });
});

// ─── env var overrides ────────────────────────────────────────────────────────

describe("loadConfig — env var handling", () => {
  test("reads ASR endpoint from RIVA_ASR_ENDPOINT", () => {
    process.env.RIVA_ASR_ENDPOINT = "asr.example.com:50055";
    expect(loadConfig().asrEndpoint).toBe("asr.example.com:50055");
  });

  test("reads NMT endpoint from RIVA_NMT_ENDPOINT", () => {
    process.env.RIVA_NMT_ENDPOINT = "nmt.example.com:50051";
    expect(loadConfig().nmtEndpoint).toBe("nmt.example.com:50051");
  });

  test("reads TTS endpoint from RIVA_TTS_ENDPOINT", () => {
    process.env.RIVA_TTS_ENDPOINT = "tts.example.com:50056";
    expect(loadConfig().ttsEndpoint).toBe("tts.example.com:50056");
  });

  test("sets tls to true when RIVA_TLS is '1'", () => {
    process.env.RIVA_TLS = "1";
    expect(loadConfig().tls).toBe(true);
  });

  test("keeps tls false when RIVA_TLS is '0'", () => {
    process.env.RIVA_TLS = "0";
    expect(loadConfig().tls).toBe(false);
  });

  test("reads apiKey from RIVA_API_KEY", () => {
    process.env.RIVA_API_KEY = "my-secret-key";
    expect(loadConfig().apiKey).toBe("my-secret-key");
  });

  test("reads inputSampleRate from INPUT_SAMPLE_RATE and converts to number", () => {
    process.env.INPUT_SAMPLE_RATE = "8000";
    expect(loadConfig().inputSampleRate).toBe(8_000);
  });

  test("reads outputSampleRate from OUTPUT_SAMPLE_RATE and converts to number", () => {
    process.env.OUTPUT_SAMPLE_RATE = "48000";
    expect(loadConfig().outputSampleRate).toBe(48_000);
  });
});

// ─── explicit overrides ───────────────────────────────────────────────────────

describe("loadConfig — explicit overrides", () => {
  test("override wins over env var for asrEndpoint", () => {
    process.env.RIVA_ASR_ENDPOINT = "env.asr:50055";
    const cfg = loadConfig({ asrEndpoint: "override.asr:9000" });
    expect(cfg.asrEndpoint).toBe("override.asr:9000");
  });

  test("override wins over env var for nmtEndpoint", () => {
    process.env.RIVA_NMT_ENDPOINT = "env.nmt:50051";
    const cfg = loadConfig({ nmtEndpoint: "override.nmt:9001" });
    expect(cfg.nmtEndpoint).toBe("override.nmt:9001");
  });

  test("override wins over env var for ttsEndpoint", () => {
    process.env.RIVA_TTS_ENDPOINT = "env.tts:50056";
    const cfg = loadConfig({ ttsEndpoint: "override.tts:9002" });
    expect(cfg.ttsEndpoint).toBe("override.tts:9002");
  });

  test("override sets tls to true even when RIVA_TLS is absent", () => {
    delete process.env.RIVA_TLS;
    const cfg = loadConfig({ tls: true });
    expect(cfg.tls).toBe(true);
  });

  test("override sets custom voiceName", () => {
    const cfg = loadConfig({ voiceName: "Magpie-Multilingual.EN-US.Sofia" });
    expect(cfg.voiceName).toBe("Magpie-Multilingual.EN-US.Sofia");
  });

  test("override sets sourceLang", () => {
    const cfg = loadConfig({ sourceLang: "fa-IR" });
    expect(cfg.sourceLang).toBe("fa-IR");
  });

  test("override sets targetLang", () => {
    const cfg = loadConfig({ targetLang: "de-DE" });
    expect(cfg.targetLang).toBe("de-DE");
  });

  test("override sets inputSampleRate and ignores env var", () => {
    process.env.INPUT_SAMPLE_RATE = "16000";
    const cfg = loadConfig({ inputSampleRate: 44_100 });
    expect(cfg.inputSampleRate).toBe(44_100);
  });

  test("override sets vadAggressiveness", () => {
    const cfg = loadConfig({ vadAggressiveness: 3 });
    expect(cfg.vadAggressiveness).toBe(3);
  });

  test("override sets verbose to true", () => {
    expect(loadConfig({ verbose: true }).verbose).toBe(true);
  });

  test("multiple overrides are all applied in one call", () => {
    const cfg = loadConfig({
      asrEndpoint: "asr:1",
      nmtEndpoint: "nmt:2",
      ttsEndpoint: "tts:3",
      tls: true,
      apiKey: "k",
      sourceLang: "ar-AR",
      targetLang: "en-US",
      voiceName: "TestVoice",
      inputSampleRate: 8_000,
      outputSampleRate: 16_000,
      vadAggressiveness: 0,
      silenceMsToFlush: 500,
      maxSegmentMs: 5_000,
      verbose: true,
    });

    expect(cfg.asrEndpoint).toBe("asr:1");
    expect(cfg.nmtEndpoint).toBe("nmt:2");
    expect(cfg.ttsEndpoint).toBe("tts:3");
    expect(cfg.tls).toBe(true);
    expect(cfg.apiKey).toBe("k");
    expect(cfg.inputSampleRate).toBe(8_000);
    expect(cfg.outputSampleRate).toBe(16_000);
    expect(cfg.vadAggressiveness).toBe(0);
    expect(cfg.silenceMsToFlush).toBe(500);
    expect(cfg.maxSegmentMs).toBe(5_000);
    expect(cfg.verbose).toBe(true);
  });

  test("unspecified fields keep their defaults when overrides are partial", () => {
    delete process.env.RIVA_ASR_ENDPOINT;
    const cfg = loadConfig({ verbose: true });
    expect(cfg.asrEndpoint).toBe("localhost:50055");
    expect(cfg.vadAggressiveness).toBe(1);
    expect(cfg.sourceLang).toBe("ar-AR");
  });
});
