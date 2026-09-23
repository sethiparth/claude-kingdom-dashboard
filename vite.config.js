import { defineConfig } from 'vite';

export default defineConfig({
  root: './client',
  publicDir: '../public',
  server: {
    port: 5173,
    open: false, // Don't auto-open Vite port
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true
      }
    }
  },
  build: {
    outDir: '../dist',
    emptyOutDir: true
  }
});
