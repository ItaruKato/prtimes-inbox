import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

// PWA: iPhoneのホーム画面に追加してアプリとして使う（朝9時の通知にも必要）
export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      // 登録は src/main.tsx の registerSW で行う（更新時に自動で再読み込みする）
      injectRegister: false,
      workbox: { clientsClaim: true, skipWaiting: true, navigateFallbackDenylist: [/^\/__/] },
      includeAssets: ['icon.svg', 'apple-touch-icon.png'],
      manifest: {
        name: 'PR Times Watcher',
        short_name: 'PR Watcher',
        lang: 'ja',
        start_url: '/',
        display: 'standalone',
        background_color: '#f5f6f8',
        theme_color: '#2a3d8f',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icon.svg', sizes: 'any', type: 'image/svg+xml' },
        ],
      },
    }),
  ],
});
