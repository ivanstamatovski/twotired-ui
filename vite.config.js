import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  base: './',          // Capacitor needs relative asset paths
  build: {
    outDir: 'dist',    // Capacitor looks here by default
  },
})
