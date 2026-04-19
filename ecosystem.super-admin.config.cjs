// ecosystem.super-admin.config.cjs
// Run: pm2 start ecosystem.super-admin.config.cjs
// Processes: SA-api (port 4000)
// Frontend (index.html) is served by the API itself as static files — no separate process needed.

module.exports = {
  apps: [
    {
      name: 'SA-api',
      cwd: './apps/super-admin',
      script: 'dist/server.js',
      node_args: '--enable-source-maps',
      instances: 1,
      env: { NODE_ENV: 'production' },
      max_memory_restart: '256M',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      error_file: '/home/agentsadmin/.pm2/logs/SA-api-error.log',
      out_file: '/home/agentsadmin/.pm2/logs/SA-api-out.log',
    },
  ],
};
