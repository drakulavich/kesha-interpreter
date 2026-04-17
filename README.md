# ar-en-simul

Simultaneous **Arabic → English** speech translator as a CLI. Runs on your Mac,
talks to an **NVIDIA Riva NMT NIM** on your Linux GPU box. Press-and-hold space
to talk, release to hear the English come back — or use `--live` for hands-free
VAD mode.

## Why this architecture

The pipeline is **one gRPC call**, not three. Riva's NMT service exposes
[`StreamingTranslateSpeechToSpeech`](https://docs.nvidia.com/deeplearning/riva/user-guide/docs/reference/protos/protos.html) —
a bidirectional stream where you push PCM16 audio in one language and the
server streams back PCM16 audio in another. Inside the container it's a cascade
(Canary or Parakeet ASR → NMT → FastPitch+HiFi-GAN TTS), but it runs entirely
on the GPU with no network hops between stages, so end-to-end latency is close
to a single-model pipeline.

| Stage | Model | Typical latency |
| --- | --- | --- |
| Arabic ASR | Canary-1B / Parakeet-RNNT multi | ~100–300 ms per chunk on an A100/L40S |
| AR → EN NMT | Riva NMT (s2s_model bundle) | ~50 ms per phrase |
| English TTS | FastPitch + HiFi-GAN en-US | ~22 ms to first audio chunk |

Realistic end-to-end: **~500–900 ms** from end-of-Arabic-phrase to start-of-English-audio on a decent GPU.

## Layout

```
ar-en-simul/
├── protos/                    # Riva .proto files (grabbed from nvidia-riva/common)
├── scripts/run-riva-nim.sh    # Launch the NIM on the Linux GPU host
└── src/
    ├── index.ts               # CLI entrypoint (commander)
    ├── config.ts              # Runtime config + env var handling
    ├── riva.ts                # gRPC client wrapping StreamingTranslateSpeechToSpeech
    ├── audio.ts               # mic capture + speaker playback (PCM16 mono)
    ├── vad.ts                 # webrtcvad-based segmenter for --live mode
    └── modes.ts               # push-to-talk and live mode controllers
```

## Server side: launch the Riva NIMs (Docker Compose)

On the Linux GPU node, with NVIDIA Container Toolkit installed:

```bash
# 1. NGC API key (https://ngc.nvidia.com → Setup → Generate API Key)
cp .env.example .env
$EDITOR .env                 # paste NGC_API_KEY=nvapi-...

# 2. One-time registry login
source .env
echo "$NGC_API_KEY" | docker login nvcr.io -u '$oauthtoken' --password-stdin

# 3. Bring up ASR + NMT + TTS
docker compose up -d
docker compose logs -f riva-nmt   # watch the model download / warm-up
```

The first launch downloads ~20–40 GB of weights across the three services and
can take 10–15 minutes. Subsequent launches are fast thanks to the shared
`nim_cache` volume. The stack publishes:

| Service | gRPC (host) | HTTP (host) | Purpose |
| --- | --- | --- | --- |
| `riva-nmt` | `50051` | `9000` | **This is what the CLI connects to** |
| `riva-asr` | `50052` | `9001` | Internal (debug direct if needed) |
| `riva-tts` | `50053` | `9002` | Internal (debug direct if needed) |

Shut it down with `docker compose down`. Weights stay in the named volume, so
the next `up` is instant.

### Single-container alternative

If you'd rather run just the NMT NIM and let it internally cascade (requires a
build that bundles ASR+TTS), use the script:

```bash
export NGC_API_KEY=nvapi-...
./scripts/run-riva-nim.sh
```

### Sanity-check the stack

```bash
# From the Linux host (or remotely if you expose the HTTP ports)
curl -fsS http://localhost:9000/v1/health/ready   # NMT
curl -fsS http://localhost:9001/v1/health/ready   # ASR
curl -fsS http://localhost:9002/v1/health/ready   # TTS

# From the Mac, confirm the gRPC RPC exists
grpcurl -plaintext <linux-host>:50051 list nvidia.riva.nmt.RivaTranslation
# -> nvidia.riva.nmt.RivaTranslation.StreamingTranslateSpeechToSpeech ...
```

### Picking different model profiles

Override `NMT_SELECTOR`, `ASR_SELECTOR`, or `TTS_SELECTOR` in `.env`. To see
what's actually baked into a given image:

```bash
docker exec riva-asr env | grep -i NIM_TAGS_SELECTOR
docker exec riva-asr ls /opt/nim/etc/default_config.d/
```

For the default Arabic streaming setup in this repo, the ASR service should use
the Parakeet RNNT multilingual **prompt** profile. The compose file defaults to
`ASR_SELECTOR=diarizer=sortformer,mode=all,type=prompt,vad=silero`, which
matches NVIDIA's documented streaming profile for prompt-conditioned Arabic.

## Client side: the CLI

On your Mac:

```bash
# Bun 1.1+ required
brew install bun sox            # sox provides the mic backend that `mic` uses
cd ar-en-simul
bun install

# Point at your Linux node
export RIVA_ENDPOINT=10.0.0.5:50051

# Push-to-talk (default): hold SPACE, release to translate
bun run start

# Always-on / VAD:
bun run start -- --live

# Custom voice, endpoint, or TLS:
bun run start -- --endpoint riva.example:443 --tls \
  --api-key "$NGC_API_KEY" --voice English-US.Male-1
```

### Tests

```bash
# Fast local suite
bun test

# Same via package script
bun run test

# Live integration path against a real Riva server
export RIVA_ENDPOINT=10.0.0.5:50051
bun run test:riva:e2e
```

The live test is opt-in and only runs when `RUN_RIVA_E2E=1` is set by the
script, so the default suite stays fast and deterministic.

Full flags:

```
--endpoint <host:port>     Riva NMT gRPC endpoint    [env: RIVA_ENDPOINT]
--tls                      use TLS                    [env: RIVA_TLS=1]
--api-key <key>            bearer token               [env: RIVA_API_KEY]
--live                     VAD mode (default: PTT)
--voice <name>             Riva TTS voice             (default: English-US.Female-1)
--source <bcp47>           source language            (default: ar-AR)
--target <bcp47>           target language            (default: en-US)
--model <name>             Riva S2S model             (default: s2s_model)
--in-sr <hz>               mic sample rate            (default: 16000)
--out-sr <hz>              playback sample rate       (default: 44100)
--vad <0-3>                VAD aggressiveness         (default: 2)
--silence-ms <ms>          silence to flush segment   (default: 600)
--max-segment-ms <ms>      hard cap per segment       (default: 8000)
-v, --verbose              verbose logging
```

## Known gotchas

- **Push-to-talk in a terminal**: terminals emit key-repeat events rather than
  clean down/up, so we infer release from a 250-ms inactivity gap. If your
  terminal drops repeats on a fast tap, just hold a hair longer.
- **Canary is offline-only per the Riva NIM docs**, but the NMT NIM wraps it
  inside the streaming S2S RPC by internally chunking at utterance boundaries.
  The RPC is streaming from the caller's perspective.
- **VAD frame size**: webrtcvad only accepts 10/20/30 ms frames of 16 kHz PCM,
  so `--in-sr` should stay at 16000 for `--live` mode.
- **`speaker` native module** occasionally fails to build on macOS 15+. If so,
  `bun install --foreground-scripts` or fall back to piping PCM to `sox -d`:
  replace the `Speaker` in `src/audio.ts` with a `child_process.spawn("play",
  ["-t", "raw", "-r", String(sr), "-e", "signed", "-b", "16", "-c", "1", "-"])`.

## Extending

- **Subtitles**: swap `StreamingTranslateSpeechToSpeech` for
  `StreamingTranslateSpeechToText` in `src/riva.ts` to also print the English
  text as it arrives. The RPC shape is identical — just different response
  type.
- **Other pairs**: change `--source` / `--target`. The same NIM supports many
  pairs; just make sure the `NIM_TAGS_SELECTOR` on the server covers them.
- **Voice cloning / zero-shot TTS**: Riva's `SynthesizeSpeechConfig` has a
  `zeroShotData` field. Populate it in `src/riva.ts` to clone your own voice
  for the English output.
