# Help Us Test kesha-interpreter 🎙️

We're building a **real-time Arabic → English simultaneous interpreter** that runs entirely on-prem using NVIDIA GPUs. Think UN-style interpretation — English voice starts speaking while you're still talking Arabic.

We need native Arabic speakers to test it and share results so we can improve ASR accuracy and translation quality.

## What you need

- Mac with [Bun](https://bun.sh) installed
- `sox` audio tool: `brew install sox`
- **Presight VPN connected** (the GPU server is on the internal network)
- GPU server IP (ask Anton)

## Setup (2 minutes)

```bash
git clone https://github.com/drakulavich/kesha-interpreter.git
cd kesha-interpreter
cp .env.example .env    # edit GPU_HOST with the server IP
bun install && bun link
```

## How to test

Run in **debug mode** — this records your speech and logs all events:

```bash
DEBUG=1 ar-en-simul --gpu <server-ip>
```

Then just **speak Arabic naturally** for 30-60 seconds. Talk about anything:
- Introduce yourself
- Describe your day
- Tell a short story
- Read a news headline

Press `q` when done.

### Push-to-talk mode (alternative)

If the always-listening mode picks up too much background noise:

```bash
DEBUG=1 ar-en-simul --gpu <server-ip> --ptt
```

Hold **SPACE** while speaking, release when done.

## What to share

After your session, two files are saved in `/tmp/`:

1. **Audio recording**: `/tmp/ar-en-debug-*.raw`
2. **Event log**: `/tmp/ar-en-debug-*.log.json`

Please share **both files** with Anton along with:
- Your dialect (Gulf, Levantine, Egyptian, MSA, etc.)
- What you said (brief summary in Arabic or English)
- Did the English translation make sense? Rate 1-5
- Did the English voice play while you were still speaking? (simultaneous or delayed?)
- Any weird behavior you noticed

## What we're looking for

| Issue | Example |
|-------|---------|
| Wrong language detection | ASR outputs Russian/English instead of Arabic |
| Bad transliteration | English words appear as Arabic letters (إيفن = "even") |
| Choppy segments | Translation cuts mid-sentence |
| Echo | TTS output gets picked up by mic and re-translated |
| Missing playback | Text appears but no English voice |
| Repeated translations | Same English phrase spoken twice |

## Replay your recording

Listen to what the mic captured:

```bash
play -t raw -r 16000 -b 16 -c 1 -e signed /tmp/ar-en-debug-*.raw
```

## Questions?

Reach out to Anton Yakutovich — anton.yakutovich@presight.ai

---

شكراً لمساعدتكم! 🙏
