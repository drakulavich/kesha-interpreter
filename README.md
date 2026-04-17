# kesha-interpreter

Simultaneous Arabic → English speech interpreter. Speaks English **while you're still talking Arabic** — like a UN interpreter with ~2s delay.

All on-prem. No cloud APIs.

## How it works

```
Mic ──PCM──→ [Parakeet ASR] ──partials──→ [Riva NMT] ──text──→ [Magpie TTS] ──audio──→ Speaker
              gRPC :50055                  gRPC :50051           gRPC :50056
              streaming                    every 1s              per chunk
```

Three NVIDIA NIM containers on your GPU server, connected via gRPC. The CLI translates ASR partials every second, speaks new English chunks immediately, and mutes the mic during playback to prevent echo.

## Demo

```
  kesha-interpreter — Arabic → English

  ✓ ASR 10.119.62.29:50055
  ✓ NMT 10.119.62.29:50051
  ✓ TTS 10.119.62.29:50056
  Always listening

  Peace be upon you, my name is Abdullah.
  I am always in the country of twenty-two and five.
  I am currently in the kitchen and eat a salad.
```

English voice plays simultaneously as Arabic speech is recognized.

## Install

```bash
git clone https://github.com/drakulavich/kesha-interpreter.git
cd kesha-interpreter
bun install && bun link
```

Requires [Bun](https://bun.sh) and `sox` (`brew install sox`).

## Modes

### Always listening (VAD)

```bash
kesha-interpreter --gpu <ip>
```

Mic is always on. Energy-based VAD detects speech segments automatically. English translation streams with ~2s delay while you're still speaking Arabic.

### Push-to-talk (offline ASR)

```bash
kesha-interpreter --gpu <ip> --ptt
```

Hold **SPACE** to record, release to translate. Uses offline (unary) ASR for better accuracy — 69% vs 60% streaming on Arabic benchmarks. Shows "Recording..." while holding, then translates and speaks the full utterance at once.

### Options

```bash
kesha-interpreter --gpu <ip> --voice Magpie-Multilingual.EN-US.Ray
DEBUG=1 kesha-interpreter --gpu <ip>           # debug: saves audio + event log
```

## Server setup

```bash
# On GPU server
cp .env.example .env          # set NGC_API_KEY
docker compose up -d          # starts ASR + NMT + TTS
```

First launch downloads ~30GB of models. Subsequent starts are instant.

### Services

| Container | Model | GPU | Port |
|-----------|-------|-----|------|
| riva-asr | [Parakeet 1.1B RNNT](https://build.nvidia.com/nvidia/parakeet-1-1b-rnnt-multilingual) | dedicated | 50055 |
| riva-nmt | [Riva Translate 1.6B](https://build.nvidia.com/nvidia/riva-translate-1_6b) | dedicated | 50051 |
| riva-tts | [Magpie TTS Multilingual](https://build.nvidia.com/nvidia/magpie-tts-multilingual) | dedicated | 50056 |

Requires NVIDIA GPU with Docker + [NGC API key](https://org.ngc.nvidia.com/).

## Voices

Male: `Leo` `Jason` `Ray` `Diego` `Pascal`
Female: `Sofia` `Mia` `Aria` `Isabela` `Louise`

Format: `Magpie-Multilingual.EN-US.<Name>` — emotions: `.Calm` `.Happy` `.Angry` `.Sad` `.Fearful`

## Debug mode

```bash
DEBUG=1 kesha-interpreter --gpu <ip>
```

Saves to `/tmp/ar-en-debug-*.raw` (mic audio) and `.log.json` (timestamped events).

Replay: `play -t raw -r 16000 -b 16 -c 1 -e signed /tmp/ar-en-debug-*.raw`

## Testing

```bash
GPU_HOST=<ip> bun test                              # all tests
GPU_HOST=<ip> bun test tests/e2e.test.ts             # pipeline (streaming + offline)
RUN_RIVA_E2E=1 GPU_HOST=<ip> bun test ./tests/ptt-offline.test.ts  # PTT offline mode
GPU_HOST=<ip> bun test tests/realtime.test.ts        # simultaneous with real Arabic
GPU_HOST=<ip> bun test tests/simultaneous.test.ts    # interpreter behavior
```

## Architecture

- `src/riva.ts` — 3-hop gRPC: streaming S2S + offline `recognizeOffline()` + `translate()` + `synthesize()`
- `src/modes.ts` — VAD live mode (streaming) + push-to-talk (offline) + debug recording
- `src/audio.ts` — Mic via `rec`, playback via `afplay`
- `src/vad.ts` — Energy-based VAD (160ms trigger, 2.5s silence)
- `src/config.ts` — Endpoints, voices, VAD tuning

## License

MIT
