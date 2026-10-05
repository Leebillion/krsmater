import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { defineConfig, loadEnv } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '.', '');

  return {
    plugins: [
      react(),
      tailwindcss(),
      VitePWA({
        registerType: 'autoUpdate',
        includeAssets: ['apple-touch-icon.png'],
        manifest: {
          id: '/',
          name: 'KRS Master',
          short_name: 'KRS Master',
          description: 'Product master upload, search, QR/barcode scan, and bundle workflows.',
          theme_color: '#002542',
          background_color: '#edf3f7',
          display: 'standalone',
          start_url: '/',
          scope: '/',
          lang: 'ko',
          icons: [
            {
              src: '/pwa-192.png',
              sizes: '192x192',
              type: 'image/png',
            },
            {
              src: '/pwa-512.png',
              sizes: '512x512',
              type: 'image/png',
            },
            {
              src: '/pwa-512.png',
              sizes: '512x512',
              type: 'image/png',
              purpose: 'maskable',
            },
          ],
        },
        workbox: {
          globPatterns: ['**/*.{js,css,html,png,svg,ico,json,woff2}'],
          // 마스터 편집(/editor/)은 별도 서버의 페이지다. 서비스 워커가 이 앱의 index.html로
          // 대신 응답하거나 편집 화면 파일을 캐시하면 안 된다.
          navigateFallbackDenylist: [/^\/editor(\/|$)/, /^\/api\//],
          runtimeCaching: [
            {
              urlPattern: ({ request, url }) => request.destination === 'document' && !url.pathname.startsWith('/editor'),
              handler: 'NetworkFirst',
              options: {
                cacheName: 'app-pages',
              },
            },
            {
              urlPattern: ({ request, url }) => ['style', 'script', 'font', 'image'].includes(request.destination) && !url.pathname.startsWith('/editor'),
              handler: 'StaleWhileRevalidate',
              options: {
                cacheName: 'app-assets',
              },
            },
          ],
        },
      }),
    ],
    define: {
      'process.env.GEMINI_API_KEY': JSON.stringify(env.GEMINI_API_KEY),
    },
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    server: {
      proxy: {
        '/api': {
          target: env.VITE_API_TARGET || 'http://localhost:3100',
          changeOrigin: true,
        },
        // 마스터 편집 서버(editor/, Python). 운영에서는 nginx가 같은 일을 한다.
        '/editor': {
          target: env.VITE_EDITOR_TARGET || 'http://localhost:8000',
          changeOrigin: true,
          rewrite: (requestPath) => requestPath.replace(/^\/editor/, '') || '/',
        },
      },
      hmr: process.env.DISABLE_HMR !== 'true',
    },
  };
});
