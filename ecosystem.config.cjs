module.exports = {
  apps: [
    {
      name: 'meridian-alerts',
      script: 'npx',
      args: 'tsx src/alerts/monitor.ts --continuous',
      cwd: __dirname,
      watch: false,
      autorestart: true,
      max_restarts: 10,
      restart_delay: 5000,
      env: {
        NODE_ENV: 'production',
      },
      // Log configuration
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      error_file: 'logs/meridian-error.log',
      out_file: 'logs/meridian-out.log',
      merge_logs: true,
      // Restart if memory exceeds 500MB
      max_memory_restart: '500M',
    },
    {
      name: 'meridian-monitor',
      script: 'npx',
      args: 'tsx src/paper/monitor.ts --watch',
      cwd: __dirname,
      watch: false,
      autorestart: true,
      max_restarts: 10,
      restart_delay: 5000,
      env: {
        NODE_ENV: 'production',
      },
      // Log configuration
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      error_file: 'logs/monitor-error.log',
      out_file: 'logs/monitor-out.log',
      merge_logs: true,
      max_memory_restart: '500M',
    },
  ],
};
