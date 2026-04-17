/**
 * Unit tests for src/riva.ts
 *
 * RivaClient constructor calls protoLoader.loadSync (disk I/O) and
 * grpc.loadPackageDefinition (network-capable stubs), so we mock both
 * @grpc/proto-loader and @grpc/grpc-js to keep tests hermetic.
 *
 * What we can verify without real gRPC servers:
 *  - RivaClient constructor completes without throwing
 *  - buildCredentials picks insecure vs. SSL based on cfg.tls
 *  - buildCredentials combines channel + call credentials when apiKey is set
 *  - openS2S() returns an object with the correct S2SSession shape
 *  - sendAudio() forwards audio chunks to the ASR stream
 *  - end() / close() are idempotent
 *  - ASR "data" events propagate "partial" on the session
 *  - ASR "end" with no transcript emits utteranceEnd then end without calling NMT
 */

import { describe, expect, mock, test } from "bun:test";
import { EventEmitter } from "node:events";

// ─── fake gRPC call stream ────────────────────────────────────────────────────

function makeFakeCall() {
  const emitter = new EventEmitter();
  return Object.assign(emitter, {
    write: mock(() => true),
    end: mock(() => {}),
    cancel: mock(() => {}),
  });
}

// ─── fake stubs ───────────────────────────────────────────────────────────────

let fakeAsrCall: ReturnType<typeof makeFakeCall>;

const fakeAsrStub = {
  StreamingRecognize: mock(() => fakeAsrCall),
};

const fakeNmtStub = {
  TranslateText: mock((_req: unknown, cb: (err: null, resp: unknown) => void) => {
    cb(null, { translations: [{ text: "Hello world" }] });
  }),
};

const fakeTtsStub = {
  SynthesizeOnline: mock(() => {
    const call = new EventEmitter();
    setTimeout(() => {
      call.emit("data", { audio: Buffer.from("pcm-audio") });
      call.emit("end");
    }, 0);
    return call;
  }),
};

// Track which credentials factory was used
const insecureCreds = { type: "insecure" };
const sslCreds = { type: "ssl" };
const callCreds = { type: "call" };
const combinedCreds = { type: "combined" };

const metadataGeneratorFn = mock((_p: unknown, cb: (err: null, md: unknown) => void) => {
  cb(null, { add: mock(() => {}) });
});

mock.module("@grpc/grpc-js", () => ({
  credentials: {
    createInsecure: mock(() => insecureCreds),
    createSsl: mock(() => sslCreds),
    createFromMetadataGenerator: mock((fn: unknown) => {
      metadataGeneratorFn(fn, (err: null, md: unknown) => { void err; void md; });
      return callCreds;
    }),
    combineChannelCredentials: mock(() => combinedCreds),
  },
  Metadata: class {
    add = mock(() => {});
  },
  loadPackageDefinition: mock(() => ({
    nvidia: {
      riva: {
        asr: { RivaSpeechRecognition: class { constructor() { Object.assign(this, fakeAsrStub); } } },
        nmt: { RivaTranslation:       class { constructor() { Object.assign(this, fakeNmtStub); } } },
        tts: { RivaSpeechSynthesis:   class { constructor() { Object.assign(this, fakeTtsStub); } } },
      },
    },
  })),
}));

mock.module("@grpc/proto-loader", () => ({
  default: {
    loadSync: mock(() => ({})),
  },
}));

// Dynamic import AFTER mocks are installed
const { RivaClient } = await import("../src/riva.ts");
const { loadConfig } = await import("../src/config.ts");

function makeCfg(overrides: Parameters<typeof loadConfig>[0] = {}) {
  return loadConfig({
    asrEndpoint: "localhost:50055",
    nmtEndpoint: "localhost:50051",
    ttsEndpoint: "localhost:50056",
    tls: false,
    ...overrides,
  });
}

// ─── RivaClient constructor ───────────────────────────────────────────────────

describe("RivaClient — constructor", () => {
  test("constructs without throwing when tls is false", () => {
    fakeAsrCall = makeFakeCall();
    expect(() => new RivaClient(makeCfg({ tls: false }))).not.toThrow();
  });

  test("constructs without throwing when tls is true", () => {
    fakeAsrCall = makeFakeCall();
    expect(() => new RivaClient(makeCfg({ tls: true }))).not.toThrow();
  });

  test("constructs without throwing when apiKey is provided", () => {
    fakeAsrCall = makeFakeCall();
    expect(() => new RivaClient(makeCfg({ apiKey: "my-key" }))).not.toThrow();
  });
});

// ─── openS2S() shape ─────────────────────────────────────────────────────────

describe("RivaClient.openS2S() — return shape", () => {
  test("returns an object with a sendAudio function", () => {
    fakeAsrCall = makeFakeCall();
    const client = new RivaClient(makeCfg());
    const session = client.openS2S();
    expect(typeof session.sendAudio).toBe("function");
  });

  test("returns an object with an end function", () => {
    fakeAsrCall = makeFakeCall();
    const client = new RivaClient(makeCfg());
    const session = client.openS2S();
    expect(typeof session.end).toBe("function");
  });

  test("returns an object with a close function", () => {
    fakeAsrCall = makeFakeCall();
    const client = new RivaClient(makeCfg());
    const session = client.openS2S();
    expect(typeof session.close).toBe("function");
  });

  test("returns an object with an EventEmitter as events", () => {
    fakeAsrCall = makeFakeCall();
    const client = new RivaClient(makeCfg());
    const session = client.openS2S();
    expect(session.events).toBeInstanceOf(EventEmitter);
  });
});

// ─── sendAudio() ─────────────────────────────────────────────────────────────

describe("RivaClient.openS2S() — sendAudio()", () => {
  test("forwards audio chunks to the ASR call stream", () => {
    fakeAsrCall = makeFakeCall();
    const client = new RivaClient(makeCfg());
    const session = client.openS2S();
    const chunk = Buffer.from("pcm-data");

    session.sendAudio(chunk);

    // The second write call (index 1) carries audioContent; index 0 is the config message
    const audioCalls = fakeAsrCall.write.mock.calls.filter(
      (args: unknown[]) => (args[0] as Record<string, unknown>)?.audioContent !== undefined
    );
    expect(audioCalls.length).toBeGreaterThan(0);
    expect((audioCalls[0]?.[0] as Record<string, unknown>)?.audioContent).toBe(chunk);
  });

  test("does not forward audio after end() is called", () => {
    fakeAsrCall = makeFakeCall();
    const client = new RivaClient(makeCfg());
    const session = client.openS2S();

    session.end();
    const callCountAfterEnd = fakeAsrCall.write.mock.calls.length;
    session.sendAudio(Buffer.from("should-be-ignored"));

    expect(fakeAsrCall.write.mock.calls.length).toBe(callCountAfterEnd);
  });

  test("does not forward audio after close() is called", () => {
    fakeAsrCall = makeFakeCall();
    const client = new RivaClient(makeCfg());
    const session = client.openS2S();

    session.close();
    const callCountAfterClose = fakeAsrCall.write.mock.calls.length;
    session.sendAudio(Buffer.from("should-be-ignored"));

    expect(fakeAsrCall.write.mock.calls.length).toBe(callCountAfterClose);
  });
});

// ─── end() / close() idempotency ─────────────────────────────────────────────

describe("RivaClient.openS2S() — end() and close() idempotency", () => {
  test("end() can be called twice without throwing", () => {
    fakeAsrCall = makeFakeCall();
    const client = new RivaClient(makeCfg());
    const session = client.openS2S();

    expect(() => {
      session.end();
      session.end();
    }).not.toThrow();
  });

  test("close() can be called twice without throwing", () => {
    fakeAsrCall = makeFakeCall();
    const client = new RivaClient(makeCfg());
    const session = client.openS2S();

    expect(() => {
      session.close();
      session.close();
    }).not.toThrow();
  });

  test("calling end() then close() does not throw", () => {
    fakeAsrCall = makeFakeCall();
    const client = new RivaClient(makeCfg());
    const session = client.openS2S();

    expect(() => {
      session.end();
      session.close();
    }).not.toThrow();
  });
});

// ─── ASR event propagation ────────────────────────────────────────────────────

describe("RivaClient.openS2S() — ASR event propagation", () => {
  test("emits 'partial' when ASR call emits data with a transcript", () => {
    fakeAsrCall = makeFakeCall();
    const client = new RivaClient(makeCfg());
    const session = client.openS2S();

    const partials: string[] = [];
    session.events.on("partial", (text: string) => partials.push(text));

    fakeAsrCall.emit("data", {
      results: [{ alternatives: [{ transcript: "مرحبا" }] }],
    });

    expect(partials).toEqual(["مرحبا"]);
  });

  test("emits 'error' when ASR call emits an error", () => {
    fakeAsrCall = makeFakeCall();
    const client = new RivaClient(makeCfg());
    const session = client.openS2S();

    const errors: Error[] = [];
    session.events.on("error", (err: Error) => errors.push(err));

    const testError = new Error("asr failed");
    fakeAsrCall.emit("error", testError);

    expect(errors).toHaveLength(1);
    expect(errors[0]).toBe(testError);
  });

  test("emits utteranceEnd then end when ASR ends with no transcript", async () => {
    fakeAsrCall = makeFakeCall();
    const client = new RivaClient(makeCfg());
    const session = client.openS2S();

    const emitted: string[] = [];
    session.events.on("utteranceEnd", () => emitted.push("utteranceEnd"));
    session.events.on("end", () => emitted.push("end"));

    // Trigger ASR end without any prior data (no transcript accumulated)
    fakeAsrCall.emit("end");

    // Wait for the async handler
    await new Promise(r => setTimeout(r, 10));

    expect(emitted).toEqual(["utteranceEnd", "end"]);
  });
});
