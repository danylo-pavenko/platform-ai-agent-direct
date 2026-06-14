# STT (Voice Notes) — Rollout on Existing Tenant

Checklist for deploying voice transcription to a tenant that already runs in production.

## Prerequisites (server)

- Python 3.10+
- `ffmpeg` + `ffprobe` (`apt install ffmpeg`)
- ~2 GB free disk (Whisper `small` model + venv)

## 1. Update `.env`

Add (adjust port if multiple tenants on one host — use `API_PORT + 5000`):

```env
STT_ENABLED=true
WHISPER_SERVICE_URL=http://127.0.0.1:8100
WHISPER_SERVICE_PORT=8100
WHISPER_SERVICE_TOKEN=<openssl rand -hex 24>
WHISPER_MODEL=small
WHISPER_LANGUAGE=uk
WHISPER_MAX_SECONDS=90
WHISPER_TIMEOUT_MS=120000
WHISPER_DEVICE=cpu
WHISPER_COMPUTE_TYPE=int8
WHISPER_CACHE_DIR=/home/<user>/platform-ai-agent-direct/.whisper-models
```

If `WHISPER_SERVICE_TOKEN` is empty, `setup-whisper.sh` generates one on first deploy.

## 2. Deploy

```bash
su - <tenant_user>
cd ~/platform-ai-agent-direct
bash infra/scripts/deploy-client.sh
```

Deploy will:

1. Run `setup-whisper.sh` (venv, faster-whisper, model warmup — idempotent)
2. Run DB migrations (including `media_attachments`)
3. Run unit tests
4. Start `{INSTANCE}-whisper` via PM2

## 3. Verify

```bash
pm2 list                          # SB-whisper (or {INSTANCE}-whisper) online
curl -s http://127.0.0.1:8100/health
curl -s http://127.0.0.1:3100/health | jq .stt
```

In admin → Settings → health check: row **«Голосові (STT / Whisper)»** should be green.

## 4. Manual test

1. Send a **voice note** in Instagram DM to the connected account.
2. In admin → Conversations → open thread:
   - `<audio>` player
   - 📝 transcript under the bubble
   - Bot reply based on spoken text
3. Check API logs:
   - `Incoming IG message media inventory` with `attachmentTypes: ["audio"]`
   - `Voice STT results` with `sttStatus: ok`
4. Trigger handoff (or write during handoff): Telegram card shows 🎤 + link **«Відкрити діалог в адмінці»**.

## 5. Troubleshooting

| Symptom | Fix |
|---------|-----|
| Whisper health fail | `pm2 logs SB-whisper`; first start downloads model (minutes) |
| Empty transcript | Check `ffmpeg`; IG CDN URL must download before expiry |
| `413` in logs | Voice > `WHISPER_MAX_SECONDS` — ask client to type or shorten |
| Duplicate STT load | Normal on first message; retries use in-memory cache |
| STT disabled | `STT_ENABLED=false` skips whisper PM2 app |

## 6. Rollback

```env
STT_ENABLED=false
```

```bash
pm2 delete SB-whisper   # optional
pm2 restart ecosystem.config.cjs --update-env
```

Existing messages keep stored audio; only new voice notes skip transcription.
