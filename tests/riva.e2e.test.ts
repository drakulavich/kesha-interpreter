import { describe, expect, test } from "bun:test";
import * as grpc from "@grpc/grpc-js";
import type { Config } from "../src/config.ts";
import { loadConfig } from "../src/config.ts";
import { RivaClient } from "../src/riva.ts";

const enabled = process.env.RUN_RIVA_E2E === "1";

function buildE2EConfig(): Config {
  return loadConfig({
    endpoint: process.env.RIVA_ENDPOINT ?? "localhost:50051",
    tls: process.env.RIVA_TLS === "1",
    apiKey: process.env.RIVA_API_KEY || undefined,
    sourceLang: process.env.RIVA_SOURCE_LANG ?? "ar",
    targetLang: process.env.RIVA_TARGET_LANG ?? "en",
    voiceName: process.env.RIVA_VOICE ?? "English-US.Female-1",
  });
}

async function waitForReady(cfg: Config): Promise<void> {
  const creds = cfg.tls
    ? grpc.credentials.createSsl()
    : grpc.credentials.createInsecure();
  const client = new grpc.Client(cfg.endpoint, creds);
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      client.close();
      reject(new Error(`Timed out waiting for the live Riva endpoint at ${cfg.endpoint}`));
    }, 10_000);

    client.waitForReady(new Date(Date.now() + 10_000), (err) => {
      clearTimeout(timeout);
      client.close();
      if (err) {
        reject(err);
        return;
      }
      resolve();
    });
  });
}

describe("live Riva E2E", () => {
  test("is opt-in by default", () => {
    expect(enabled).toBe(process.env.RUN_RIVA_E2E === "1");
  });

  test(
    "loads local protos and reaches a live Riva endpoint",
    async () => {
      if (!enabled) {
        return;
      }

      const cfg = buildE2EConfig();

      expect(() => new RivaClient(cfg)).not.toThrow();
      await waitForReady(cfg);
    },
    15_000,
  );
});
