#!/usr/bin/env bash
#
# Launch the NVIDIA Riva NMT NIM on your Linux GPU node.
#
# Prereqs (one-time):
#   1. NVIDIA driver + NVIDIA Container Toolkit installed
#        https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html
#   2. NGC API key -> https://ngc.nvidia.com -> Setup -> Generate API Key
#        export NGC_API_KEY=nvapi-...
#        docker login nvcr.io -u '$oauthtoken' -p "$NGC_API_KEY"
#
# The NMT NIM bundles ASR (Canary / Parakeet multilingual) + NMT + TTS
# (FastPitch/HiFi-GAN en-US), which is exactly what
# StreamingTranslateSpeechToSpeech needs for ar -> en.
#
# We cache models outside the container so restarts take seconds instead of
# minutes, and we expose both gRPC (:50051) and the HTTP proxy (:9000).
set -euo pipefail

: "${NGC_API_KEY:?Set NGC_API_KEY first (see header of this script)}"

CONTAINER_NAME="${CONTAINER_NAME:-riva-nmt}"
IMAGE="${IMAGE:-nvcr.io/nim/nvidia/riva-nmt:latest}"
CACHE_DIR="${CACHE_DIR:-$HOME/.cache/nim/riva-nmt}"
GPU_DEVICE="${GPU_DEVICE:-0}"

mkdir -p "$CACHE_DIR"
chmod 777 "$CACHE_DIR"

# Tag selector picks the right model bundle. "s2s" mode is what enables the
# StreamingTranslateSpeechToSpeech RPC. Override via NIM_TAGS_SELECTOR env.
SELECTOR="${NIM_TAGS_SELECTOR:-mode=s2s,src_lang=ar-AR,tgt_lang=en-US}"

echo "▶ Launching $CONTAINER_NAME on GPU $GPU_DEVICE"
echo "  selector : $SELECTOR"
echo "  cache    : $CACHE_DIR"

exec docker run -it --rm \
  --name "$CONTAINER_NAME" \
  --runtime=nvidia \
  --gpus "\"device=$GPU_DEVICE\"" \
  --shm-size=8GB \
  -e NGC_API_KEY \
  -e NIM_TAGS_SELECTOR="$SELECTOR" \
  -e NIM_HTTP_API_PORT=9000 \
  -e NIM_GRPC_API_PORT=50051 \
  -p 9000:9000 \
  -p 50051:50051 \
  -v "$CACHE_DIR":/opt/nim/.cache \
  "$IMAGE"
