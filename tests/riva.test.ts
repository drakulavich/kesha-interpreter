import { describe, expect, test } from "bun:test";
import { buildS2SConfigMessage } from "../src/riva.ts";

describe("buildS2SConfigMessage", () => {
  test("uses grpc-js camelCase field names and nested ASR config for the streaming payload", () => {
    const msg = buildS2SConfigMessage({
      endpoint: "localhost:50051",
      tls: false,
      sourceLang: "ar-AR",
      targetLang: "en-US",
      voiceName: "English-US.Female-1",
      s2sModel: "s2s_model",
      inputSampleRate: 16_000,
      outputSampleRate: 44_100,
      vadAggressiveness: 2,
      silenceMsToFlush: 600,
      maxSegmentMs: 8_000,
      interimResults: true,
      verbose: false,
    });

    expect(msg).toEqual({
      config: {
        asrConfig: {
          config: {
            encoding: 1,
            sampleRateHertz: 16_000,
            languageCode: "ar-AR",
            maxAlternatives: 1,
            enableAutomaticPunctuation: true,
            audioChannelCount: 1,
          },
          interimResults: true,
        },
        translationConfig: {
          sourceLanguageCode: "ar-AR",
          targetLanguageCode: "en-US",
          modelName: "s2s_model",
        },
        ttsConfig: {
          encoding: 1,
          sampleRateHz: 44_100,
          voiceName: "English-US.Female-1",
          languageCode: "en-US",
        },
      },
    });
  });
});
