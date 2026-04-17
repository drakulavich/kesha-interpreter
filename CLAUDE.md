# CLAUDE.md

## What This Is

Simultaneous Arabic → English speech interpreter CLI. Like a UN interpreter — speaks English with ~2s delay while the Arabic speaker is still talking.

## Core Behavior

1. **While you speak**: English text appears progressively (partial translations, updating in-place)
2. **With ~2s delay**: English voice starts speaking chunks — overlapping with your Arabic
3. **Natural speech**: Don't wait for sentence end. Speak each translated chunk as it arrives.

## Architecture

3-hop gRPC pipeline, each service in its own NVIDIA NIM container:

```
Mic → [Parakeet ASR :50055] → partials → [Riva NMT :50051] → English chunks → [Magpie TTS :50056] → Speaker
       streaming gRPC          debounced 600ms                   per-chunk synthesis
```

- ASR streams partials as you speak
- Every 600ms of stable text → translate → if 20+ new chars → synthesize + play
- On ASR end → translate remainder → synthesize → play
- TTS calls are serialized (queued) so chunks play in order

## GPU Server

```bash
cd ar-en-simul && docker compose up -d   # 3 containers: riva-asr, riva-nmt, riva-tts
```

Ports: ASR=50055, NMT=50051, TTS=50056. Each on its own GPU.

## Testing

```bash
GPU_HOST=10.119.62.29 bun test                    # all tests
GPU_HOST=10.119.62.29 bun test tests/e2e.test.ts  # pipeline E2E
GPU_HOST=10.119.62.29 bun test tests/simultaneous.test.ts  # interpreter behavior
```

## Key Files

- `src/riva.ts` — The brain. 3-hop gRPC with partial translation + incremental TTS
- `src/modes.ts` — VAD live mode + push-to-talk mode
- `src/audio.ts` — Mic via `rec`, playback via `afplay` (macOS)
- `src/vad.ts` — Energy-based VAD (160ms trigger, 2s silence to flush)
- `src/config.ts` — Endpoints, language codes, VAD tuning

## Known Issues

- Riva S2S cascade (`StreamingTranslateSpeechToSpeech`) strips BCP-47 region codes — that's why we use 3-hop instead
- `afplay` is macOS-only. Linux needs `aplay` or `paplay` fallback.
- VAD is energy-based (no WebRTC VAD) — may trigger on non-speech noise
