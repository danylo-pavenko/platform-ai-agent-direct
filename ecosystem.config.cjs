// ecosystem.config.cjs
// Prefix: INSTANCE_ID from .env (e.g. SB for StatusBlessed, TKP for TviyKP).
// Ports are baked in at `pm2 start/restart` time (from the shell env exported
// by deploy-client.sh) so each tenant's processes bind to their own ports
// regardless of what the shared PM2 daemon inherited from a previous tenant.
const path = require('node:path');

const prefix = (process.env.INSTANCE_ID || 'sb').toUpperCase();
const apiPort = process.env.API_PORT || '3100';
const adminPort = process.env.ADMIN_PORT || '3101';
const sttEnabled = (process.env.STT_ENABLED || 'true').toLowerCase() === 'true';
const projectRoot = path.resolve(__dirname);

/** Whisper port: API_PORT+5000; ignore legacy 8100 when API_PORT is not 3100 (multi-tenant VPS). */
function resolveWhisperPort(apiPortStr, envPortStr) {
  const api = Number(apiPortStr) || 3100;
  const derived = api + 5000;
  if (!envPortStr) return String(derived);
  const envPort = Number(envPortStr);
  if (envPort === 8100 && api !== 3100) return String(derived);
  return String(envPort);
}

const whisperPort = resolveWhisperPort(apiPort, process.env.WHISPER_SERVICE_PORT);

const apps = [
  {
    name: `${prefix}-api`,
    cwd: './apps/backend',
    script: 'dist/server.js',
    node_args: '--enable-source-maps',
    instances: 1,
    env: {
      NODE_ENV: 'production',
      API_PORT: apiPort,
      UPLOADS_DIR: process.env.UPLOADS_DIR || path.join(projectRoot, 'uploads'),
    },
    max_memory_restart: '512M',
    log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
  },
  {
    name: `${prefix}-bot`,
    cwd: './apps/backend',
    script: 'dist/telegram-bot.js',
    instances: 1,
    env: { NODE_ENV: 'production', API_PORT: apiPort },
    max_memory_restart: '256M',
  },
  {
    name: `${prefix}-sync`,
    cwd: './apps/backend',
    script: 'dist/sync-worker.js',
    instances: 1,
    cron_restart: '*/30 * * * *',
    autorestart: false,
    env: { NODE_ENV: 'production', API_PORT: apiPort },
  },
  {
    name: `${prefix}-admin`,
    cwd: './apps/admin',
    script: 'node_modules/.bin/serve',
    args: `-s dist -l ${adminPort}`,
    instances: 1,
    env: { NODE_ENV: 'production', ADMIN_PORT: adminPort },
  },
];

if (sttEnabled) {
  apps.push({
    name: `${prefix}-whisper`,
    cwd: './apps/whisper-server',
    script: 'server.py',
    interpreter: path.join(projectRoot, '.whisper-venv', 'bin', 'python'),
    instances: 1,
    autorestart: true,
    max_memory_restart: '1500M',
    env: {
      NODE_ENV: 'production',
      WHISPER_HOST: '127.0.0.1',
      WHISPER_SERVICE_PORT: whisperPort,
      WHISPER_MODEL: process.env.WHISPER_MODEL || 'small',
      WHISPER_LANGUAGE: process.env.WHISPER_LANGUAGE || 'uk',
      WHISPER_MAX_SECONDS: process.env.WHISPER_MAX_SECONDS || '90',
      WHISPER_DEVICE: process.env.WHISPER_DEVICE || 'cpu',
      WHISPER_COMPUTE_TYPE: process.env.WHISPER_COMPUTE_TYPE || 'int8',
      WHISPER_CACHE_DIR: process.env.WHISPER_CACHE_DIR || path.join(projectRoot, '.whisper-models'),
      WHISPER_WARMUP_ON_START: process.env.WHISPER_WARMUP_ON_START || 'true',
      UPLOADS_DIR: process.env.UPLOADS_DIR || path.join(projectRoot, 'uploads'),
      WHISPER_SERVICE_TOKEN: process.env.WHISPER_SERVICE_TOKEN || '',
    },
    log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
  });
}

module.exports = { apps };
