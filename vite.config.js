import { defineConfig } from 'vite'

// GitHub Pages project site: https://<user>.github.io/racing_win_place/
// Set VITE_BASE=/racing_win_place/ in the deploy workflow (local dev uses /).
const base = process.env.VITE_BASE || '/'

export default defineConfig({
  base,
  server: {
    host: '127.0.0.1',
    port: 5501,
    strictPort: true
  }
})
