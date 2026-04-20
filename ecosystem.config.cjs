// ecosystem.config.cjs
// Prefix: INSTANCE_ID from .env (SB for StatusBlessed)
const prefix = (process.env.INSTANCE_ID || 'sb').toUpperCase();

module.exports = {
  apps: [
    {
      name: `${prefix}-api`,
      cwd: './apps/backend',
      script: 'dist/server.js',
      node_args: '--enable-source-maps',
      instances: 1,
      env: { NODE_ENV: 'production' },
      max_memory_restart: '512M',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    },
    {
      name: `${prefix}-bot`,
      cwd: './apps/backend',
      script: 'dist/telegram-bot.js',
      instances: 1,
      env: { NODE_ENV: 'production' },
      max_memory_restart: '256M',
    },
    {
      name: `${prefix}-sync`,
      cwd: './apps/backend',
      script: 'dist/sync-worker.js',
      instances: 1,
      cron_restart: '*/30 * * * *',
      autorestart: false,
      env: { NODE_ENV: 'production' },
    },
    {
      name: `${prefix}-admin`,
      cwd: './apps/admin',
      script: 'node_modules/.bin/serve',
      args: `-s dist -l ${process.env.ADMIN_PORT || 3101}`,
      instances: 1,
      env: { NODE_ENV: 'production' },
    },
  ],
};
