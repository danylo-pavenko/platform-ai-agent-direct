// ecosystem.config.cjs
// Prefix: INSTANCE_ID from .env (e.g. SB for StatusBlessed, TKP for TviyKP).
// Ports are baked in at `pm2 start/restart` time (from the shell env exported
// by deploy-client.sh) so each tenant's processes bind to their own ports
// regardless of what the shared PM2 daemon inherited from a previous tenant.
const prefix = (process.env.INSTANCE_ID || 'sb').toUpperCase();
const apiPort = process.env.API_PORT || '3100';
const adminPort = process.env.ADMIN_PORT || '3101';

module.exports = {
  apps: [
    {
      name: `${prefix}-api`,
      cwd: './apps/backend',
      script: 'dist/server.js',
      node_args: '--enable-source-maps',
      instances: 1,
      env: { NODE_ENV: 'production', API_PORT: apiPort },
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
  ],
};
