import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      // Forward API calls to Flask during development
      '/jobs': 'http://localhost:5000',
      '/mux-video': 'http://localhost:5000',
    },
  },
  build: {
    outDir: 'dist',
  },
})