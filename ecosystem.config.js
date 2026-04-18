module.exports = {
  apps: [{
    name: 'whatsapp-bot',
    script: 'bot.js',
    // Options reference: https://pm2.keymetrics.io/docs/usage/application-declaration/
    instances: 1,
    autorestart: true,
    watch: false, // Disable global watch to prevent restart loops
    max_memory_restart: '800M',
    env: {
      NODE_ENV: 'production'
    },
    // Files to ignore from watching if you ever decide to enable watch
    ignore_watch: [
      'node_modules',
      '.wwebjs_auth',
      '.wwebjs_cache',
      'sessions.json',
      'token.json',
      '.env',
      '*.log'
    ],
    // Log files
    error_file: 'logs/err.log',
    out_file: 'logs/out.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
    // Merge logs from multiple instances if used
    merge_logs: true
  }]
};
