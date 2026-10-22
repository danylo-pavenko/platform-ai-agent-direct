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
      // Pin system NodeSource binary — shell PATH may prefer cursor-agent's older Node.
      interpreter: '/usr/bin/node',
      node_args: '--enable-source-maps',
      instances: 1,
      exec_mode: 'fork', // avoid cluster kill quirks; single process is enough for SA
      autorestart: true,
      max_restarts: 20,
      min_uptime: '10s',
      env: {
        NODE_ENV: 'production',
        PATH: '/usr/bin:/bin:/usr/local/bin',
      },
      max_memory_restart: '256M',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      error_file: '/home/agentsadmin/.pm2/logs/SA-api-error.log',
      out_file: '/home/agentsadmin/.pm2/logs/SA-api-out.log',
    },
  ],
};
