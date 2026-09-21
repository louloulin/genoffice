import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

/**
 * Vite config for the embed-react example.
 *
 * The `server.proxy` block forwards `/api` and `/embed` to a locally running
 * GenOffice web-server so the iframe can load the editor without CORS
 * friction during development.
 */
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:18082',
      '/embed': 'http://localhost:18082',
    },
  },
})
