module.exports = {
  apps: [
    {
      name: 'nanoclaw',
      script: 'dist/index.js',
      cwd: __dirname,
      watch: false,
      autorestart: true,
      max_restarts: 10,
      restart_delay: 3000,
      out_file: 'logs/nanoclaw.log',
      error_file: 'logs/nanoclaw-error.log',
      merge_logs: true,
      time: true,
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};
