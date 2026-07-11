// Конфигурация PM2. Запуск: pm2 start ecosystem.config.js
module.exports = {
  apps: [
    {
      name: 'tiktok-bot',
      script: 'src/index.js',
      cwd: __dirname,
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      // Перезапуск при утечке памяти — последний рубеж стабильности.
      max_memory_restart: '300M',
      restart_delay: 3000,
      // Дать боту время корректно завершить текущую отправку.
      kill_timeout: 20000,
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};
