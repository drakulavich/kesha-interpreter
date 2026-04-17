# ar-en-simul

Live Arabic → English speech translator. Speak Arabic, hear English. All on-prem.

```
Mic → [Parakeet ASR] → [Riva NMT] → [Magpie TTS] → Speaker
       gRPC :50055      gRPC :50051   gRPC :50056
```

## Quick Start

```bash
# 1. Clone & install
git clone https://github.com/drakulavich/ar-en-simul.git
cd ar-en-simul
cp .env.example .env    # edit GPU_HOST
bun install && bun link

# 2. Start GPU services
ssh gpu 'cd ar-en-simul && docker compose up -d'

# 3. Run
ar-en-simul --gpu <your-gpu-ip>
```

## Usage

```bash
ar-en-simul                              # always listening (VAD)
ar-en-simul --ptt                        # push-to-talk (hold SPACE)
ar-en-simul --voice Magpie-Multilingual.EN-US.Ray
ar-en-simul --verbose                    # show ASR partials
```

## Voices

Male: `Leo` `Jason` `Ray` `Diego` `Pascal`
Female: `Sofia` `Mia` `Aria` `Isabela` `Louise`

Format: `Magpie-Multilingual.EN-US.<Name>` — add `.Calm` `.Happy` `.Angry` for emotions.

## Prerequisites

- [Bun](https://bun.sh) + `sox` (`brew install sox`)
- GPU server with Docker + NVIDIA runtime
- [NGC API key](https://org.ngc.nvidia.com/)

## Models

| Service | Model | Port |
|---------|-------|------|
| ASR | [Parakeet 1.1B RNNT](https://build.nvidia.com/nvidia/parakeet-1-1b-rnnt-multilingual) | 50055 |
| NMT | [Riva Translate 1.6B](https://build.nvidia.com/nvidia/riva-translate-1_6b) | 50051 |
| TTS | [Magpie TTS Multilingual](https://build.nvidia.com/nvidia/magpie-tts-multilingual) | 50056 |
