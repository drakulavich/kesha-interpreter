import { afterEach, describe, expect, test } from "bun:test";
import { loadConfig } from "../src/config.ts";

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("loadConfig", () => {
  test("reads defaults from the environment", () => {
    process.env.RIVA_ENDPOINT = "example.com:50051";
    process.env.RIVA_TLS = "1";
    process.env.RIVA_API_KEY = "secret";
    process.env.INPUT_SAMPLE_RATE = "22050";
    process.env.OUTPUT_SAMPLE_RATE = "48000";

    const cfg = loadConfig();

    expect(cfg.endpoint).toBe("example.com:50051");
    expect(cfg.tls).toBe(true);
    expect(cfg.apiKey).toBe("secret");
    expect(cfg.inputSampleRate).toBe(22_050);
    expect(cfg.outputSampleRate).toBe(48_000);
  });

  test("lets explicit overrides win over environment values", () => {
    process.env.RIVA_ENDPOINT = "env.example:50051";
    process.env.RIVA_TLS = "0";
    process.env.INPUT_SAMPLE_RATE = "16000";

    const cfg = loadConfig({
      endpoint: "override.example:443",
      tls: true,
      inputSampleRate: 8_000,
      voiceName: "CustomVoice",
    });

    expect(cfg.endpoint).toBe("override.example:443");
    expect(cfg.tls).toBe(true);
    expect(cfg.inputSampleRate).toBe(8_000);
    expect(cfg.voiceName).toBe("CustomVoice");
  });
});
