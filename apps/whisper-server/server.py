#!/usr/bin/env python3
"""
Local faster-whisper HTTP service for tenant STT.

Binds to 127.0.0.1 only. Accepts absolute paths under UPLOADS_DIR (shared with backend).
"""
from __future__ import annotations

import os
import subprocess
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel, Field

app = FastAPI(title="Tenant Whisper STT", version="1.0.0")

_model = None
_model_name: Optional[str] = None


class TranscribeRequest(BaseModel):
    path: str = Field(..., description="Absolute path to an audio file under UPLOADS_DIR")


class TranscribeResponse(BaseModel):
    text: str
    language: Optional[str] = None
    durationSec: Optional[float] = None


def _env(name: str, default: str = "") -> str:
    return os.environ.get(name, default).strip()


def _uploads_root() -> Path:
    root = _env("UPLOADS_DIR", "./uploads")
    return Path(root).resolve()


def _validate_path(file_path: str) -> Path:
    uploads = _uploads_root()
    candidate = Path(file_path).resolve()
    try:
        candidate.relative_to(uploads)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="Path outside UPLOADS_DIR") from exc
    if not candidate.is_file():
        raise HTTPException(status_code=404, detail="File not found")
    return candidate


def _check_token(header: Optional[str]) -> None:
    expected = _env("WHISPER_SERVICE_TOKEN")
    if not expected:
        raise HTTPException(status_code=503, detail="WHISPER_SERVICE_TOKEN not configured")
    if not header or header != expected:
        raise HTTPException(status_code=401, detail="Unauthorized")


def _probe_duration_sec(path: Path) -> Optional[float]:
    try:
        out = subprocess.check_output(
            [
                "ffprobe",
                "-v",
                "error",
                "-show_entries",
                "format=duration",
                "-of",
                "default=noprint_wrappers=1:nokey=1",
                str(path),
            ],
            stderr=subprocess.DEVNULL,
            text=True,
            timeout=15,
        ).strip()
        if out:
            return float(out)
    except (subprocess.SubprocessError, ValueError, FileNotFoundError):
        return None
    return None


def _load_model():
    global _model, _model_name
    if _model is not None:
        return _model
    from faster_whisper import WhisperModel

    model_size = _env("WHISPER_MODEL", "small")
    device = _env("WHISPER_DEVICE", "cpu")
    compute_type = _env("WHISPER_COMPUTE_TYPE", "int8")
    cache_dir = _env("WHISPER_CACHE_DIR") or None
    _model_name = model_size
    _model = WhisperModel(
        model_size,
        device=device,
        compute_type=compute_type,
        download_root=cache_dir,
    )
    return _model


@app.on_event("startup")
def startup() -> None:
    if _env("WHISPER_WARMUP_ON_START", "true").lower() == "true":
        _load_model()


@app.get("/health")
def health() -> dict:
    return {
        "status": "ok",
        "model": _model_name or _env("WHISPER_MODEL", "small"),
        "uploadsDir": str(_uploads_root()),
    }


@app.post("/v1/transcribe", response_model=TranscribeResponse)
def transcribe(
    body: TranscribeRequest,
    x_whisper_token: Optional[str] = Header(default=None, alias="X-Whisper-Token"),
) -> TranscribeResponse:
    _check_token(x_whisper_token)
    audio_path = _validate_path(body.path)

    max_seconds = float(_env("WHISPER_MAX_SECONDS", "90") or "90")
    duration = _probe_duration_sec(audio_path)
    if duration is not None and duration > max_seconds:
        raise HTTPException(
            status_code=413,
            detail=f"Audio too long ({duration:.1f}s > {max_seconds}s)",
        )

    language = _env("WHISPER_LANGUAGE", "uk") or None
    model = _load_model()
    segments, info = model.transcribe(
        str(audio_path),
        language=language,
        beam_size=1,
        vad_filter=True,
        condition_on_previous_text=False,
    )
    text = " ".join(seg.text.strip() for seg in segments if seg.text and seg.text.strip())

    return TranscribeResponse(
        text=text.strip(),
        language=getattr(info, "language", None),
        durationSec=getattr(info, "duration", duration),
    )


def main() -> None:
    import uvicorn

    host = _env("WHISPER_HOST", "127.0.0.1")
    port = int(_env("WHISPER_SERVICE_PORT", "8100"))
    uvicorn.run("server:app", host=host, port=port, log_level=_env("WHISPER_LOG_LEVEL", "info"))


if __name__ == "__main__":
    main()
