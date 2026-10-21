import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

// Build para el WebView de Android. Usa el MISMO codigo fuente de la UI de Windows;
// solo redirige los tres modulos de Tauri a shims del puente.
//   vite build --config vite.config.android.ts               -> produccion (sin puente de prueba)
//   vite build --config vite.config.android.ts --mode test   -> incluye la pagina de prueba con puente falso
export default defineConfig(({ mode }) => ({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@tauri-apps/api/core': path.resolve(__dirname, './src/platform/shim/core.ts'),
      '@tauri-apps/api/event': path.resolve(__dirname, './src/platform/shim/event.ts'),
      '@tauri-apps/api/window': path.resolve(__dirname, './src/platform/shim/window.ts'),
    },
  },
  build: {
    outDir: mode === 'test' ? 'dist-android-test' : 'dist-android',
    emptyOutDir: true,
    chunkSizeWarningLimit: 1200,
    rollupOptions: {
      input: mode === 'test'
        ? { main: path.resolve(__dirname, 'index.android.html'), test: path.resolve(__dirname, 'index.android-test.html') }
        : { main: path.resolve(__dirname, 'index.android.html') },
    },
  },
  base: './',
}));
