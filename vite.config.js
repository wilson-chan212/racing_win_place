import { defineConfig } from 'vite'

// Ensure CSS imports are handled by Vite (served as JS module wrapper)
export default defineConfig({
  server: {
    host: '127.0.0.1',
    port: 5501,
    strictPort: true
  }
})
