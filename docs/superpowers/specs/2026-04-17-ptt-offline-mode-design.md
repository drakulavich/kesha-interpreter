# PTT Offline Mode — Design Spec

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Improve PTT translation quality by using offline (unary) ASR instead of streaming, since offline Parakeet scores 69% vs 60% streaming on Arabic.

**Architecture:** When user holds SPACE, buffer all audio. On release, send the full PCM blob to the unary `Recognize` RPC for better accuracy, then translate and speak. Live/VAD mode is unchanged.

---

## Motivation

Streaming ASR produces noisy partials that degrade translation quality. In PTT mode we know exactly when speech starts and ends, so there's no reason to stream — we can send the complete utterance for offline recognition, which gives measurably better results.

Benchmarks on 100 Common Voice Arabic samples:
- Offline `Recognize`: **69% accuracy**
- Streaming `StreamingRecognize`: **60% accuracy**

## Pipeline

```
Hold SPACE → buffer PCM chunks
Release SPACE →
  Buffer ──full PCM──→ [Recognize]     ──arabic text──→ [TranslateText] ──english──→ [Synthesize] ──audio──→ Speaker
                        unary gRPC                       unary gRPC                   unary gRPC
```

All three hops are unary gRPC calls, executed sequentially. No streaming, no periodic intervals, no partial translations.

## UX

1. User presses SPACE — UI shows dim "Recording..." indicator
2. User releases SPACE — UI shows dim "Translating..." indicator
3. NMT returns — display English text immediately
4. TTS returns — play English audio

If any hop fails (empty ASR, NMT error, TTS error), show error and reset to ready state.

Echo suppression is not needed — mic is only active while SPACE is held, and playback happens after release.

## Files Changed

### `src/riva.ts`

- Add `recognizeOffline(audio: Buffer): Promise<string>` to `RivaClient`
  - Calls the unary `Recognize` RPC with the full PCM buffer
  - Uses same `RecognitionConfig` as streaming (encoding, sample rate, language, punctuation) but without `interimResults` or `streamingConfig`
- Make `translate(text: string): Promise<string>` public (currently private)
- Make `synthesize(text: string): Promise<Buffer>` public (currently private)

### `src/modes.ts`

Rewrite `runPushToTalk()`:

- Remove `openS2S()` and `wireSession()` usage
- On SPACE down: set `recording = true`, show "Recording..." indicator, start buffering audio chunks into an array
- On SPACE release: set `recording = false`, concatenate buffer, show "Translating...", run sequential pipeline:
  1. `recognizeOffline(buffer)` → arabic text
  2. `translate(arabic)` → english text (display immediately)
  3. `synthesize(english)` → audio (play)
- Keep debug recording (audioFile + eventLog) unchanged
- Keep `q` / Ctrl+C shutdown behavior unchanged

### `src/ui.ts`

- Add `recording()` function — shows dim "Recording..." status line
- Add `translating()` function — shows dim "Translating..." status line

### No changes

- `src/config.ts` — same endpoints, sample rates, VAD config
- `src/audio.ts` — same mic/player implementation
- `src/vad.ts` — not used in PTT mode
- `docker-compose.yml` — same services
- Live/VAD mode (`runLive`) — completely unchanged

## Testing

- Unit test: `recognizeOffline()` with a known Arabic audio fixture returns Arabic text
- Integration test: full offline pipeline (Recognize → NMT → TTS) produces English audio
- Compare offline vs streaming ASR output on the same Arabic audio fixture to verify offline is better or equal
