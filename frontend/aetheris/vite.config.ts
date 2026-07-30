import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Fixed, non-hashed output filenames for v1: the Express server just needs to
// serve /aetheris-app/aetheris.js and /aetheris-app/aetheris.css directly, no
// manifest-reading step needed in server.js or home.html. Revisit hashed
// filenames + manifest injection once this integration pattern is proven.
export default defineConfig({
  base: '/aetheris-app/',
  plugins: [react()],
  build: {
    rollupOptions: {
      output: {
        entryFileNames: 'aetheris.js',
        chunkFileNames: 'aetheris-[name].js',
        assetFileNames: (assetInfo) => {
          const name = assetInfo.name ?? assetInfo.names?.[0] ?? ''
          if (name.endsWith('.css')) return 'aetheris.css'
          return 'assets/[name][extname]'
        },
      },
    },
  },
})
