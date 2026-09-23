import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { devServerApi } from './devServerApi.js';

export default defineConfig({
  // Локально серверлес-функции из api/ обслуживает плагин, на проде — Vercel.
  plugins: [react(), devServerApi()],
  server: {
    port: 5173,
    host: true,
  },
  build: {
    target: 'es2022',
    sourcemap: true,
    rollupOptions: {
      /*
       * Две страницы: приложение и витрина `/welcome` для трафика не из
       * Telegram. Витрина не тянет ни React, ни Supabase — у человека
       * из поста десять секунд, и ждать бандл приложения ему незачем.
       */
      input: {
        index: fileURLToPath(new URL('./index.html', import.meta.url)),
        welcome: fileURLToPath(new URL('./welcome.html', import.meta.url)),
      },
      output: {
        /**
         * Библиотеки меняются реже кода приложения — своими чанками,
         * чтобы деплой не сбрасывал их из кэша браузера.
         *
         * canvas-confetti здесь намеренно НЕТ: он нужен только празднованию
         * мэтча, которое загружается по случаю. В общем чанке он приезжал
         * бы на каждом холодном старте, включая тех, кто до комнаты
         * не дошёл. Набора иконок в списке тоже нет: он крупный, но
         * попадает в основной чанк только теми иконками, что реально
         * используются.
         */
        manualChunks: {
          supabase: ['@supabase/supabase-js'],
          react: ['react', 'react-dom'],
        },
      },
    },
    chunkSizeWarningLimit: 700,
  },
});
