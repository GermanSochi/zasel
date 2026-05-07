import { defineConfig } from 'vite'

const crossOriginHeaders = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
}

export default defineConfig({
  base: process.env.VERCEL ? '/' : '/zasel/',
  server: { headers: crossOriginHeaders },
  preview: { headers: crossOriginHeaders },
  build: {
    rollupOptions: {
      // WASM файлы берутся из public/ort/ — не нужно их бандлить
      external: (id) => id.endsWith('.wasm'),
    },
  },
  optimizeDeps: {
    exclude: ['onnxruntime-web'],
  },
})
