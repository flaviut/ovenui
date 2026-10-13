import { defineConfig } from 'vite';
export default defineConfig({ base: './', build: { rollupOptions: { input: { program: 'index.html', calibrate: 'calibrate.html' } } } });
