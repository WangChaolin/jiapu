import { defineConfig } from 'electron-vite'
import vue from '@vitejs/plugin-vue'
import { resolve } from 'node:path'

export default defineConfig({
  main: {
    build: {
      rollupOptions: {
        input: resolve('electron/main/index.ts'),
        external: ['node:sqlite']
      }
    }
  },
  preload: {
    build: {
      rollupOptions: {
        input: resolve('electron/preload/index.ts')
      }
    }
  },
  renderer: {
    root: resolve('.'),
    plugins: [vue()],
    resolve: {
      alias: {
        '@': resolve('src'),
        '@shared': resolve('electron/shared')
      }
    },
    build: {
      outDir: resolve('out/renderer'),
      rollupOptions: {
        input: resolve('index.html')
      }
    }
  }
})