#!/usr/bin/env python3
"""Download and load the Whisper model once (idempotent warmup for deploy)."""
from __future__ import annotations

import os
import sys

from faster_whisper import WhisperModel


def main() -> int:
    model_size = os.environ.get("WHISPER_MODEL", "small")
    device = os.environ.get("WHISPER_DEVICE", "cpu")
    compute_type = os.environ.get("WHISPER_COMPUTE_TYPE", "int8")
    cache_dir = os.environ.get("WHISPER_CACHE_DIR") or None

    print(f"Warming up faster-whisper model={model_size} device={device} compute={compute_type}")
    WhisperModel(model_size, device=device, compute_type=compute_type, download_root=cache_dir)
    print("Model ready")
    return 0


if __name__ == "__main__":
    sys.exit(main())
