import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

/**
 * Vite config for the embed-vue example.
 *
 * Proxies `/api` and `/embed` to a locally running GenOffice web-server
 * so the iframe loads without CORS friction during development.
 */
export default defineConfig({
  plugins: [vue()],
  server: {
    port: 5174,
    proxy: {
      '/api': 'http://localhost:18082',
      '/embed': 'http://localhost:18082',
    },
  },
})
