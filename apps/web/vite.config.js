import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({ plugins: [react()], server: { port: 5173, strictPort: true, proxy: { '/api': { target: process.env.API_PROXY_TARGET || 'http://localhost:4000', changeOrigin: false }, '/socket.io': { target: process.env.API_PROXY_TARGET || 'http://localhost:4000', ws: true, changeOrigin: false } } }, build: { rollupOptions: { output: { manualChunks: id => id.includes('/three/') ? 'three' : /node_modules\/(react|react-dom|@tanstack)\//.test(id) ? 'vendor' : undefined } } } });
