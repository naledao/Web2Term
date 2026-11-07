import { dirname, resolve } from 'node:path'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { PDF_ASSETS } from './src/shared/pdf-assets'
import { configureWindowsDevelopmentRuntime } from './build/windows-dev-runtime'

const resolvePackage = createRequire(import.meta.url)

const config = defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()]
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: { rollupOptions: { input: {
      index: resolve(__dirname, 'src/preload/index.ts'),
      overlay: resolve(__dirname, 'src/preload/overlay.ts')
    } } }
  },
  renderer: {
    // Windows (Hyper-V/WinNAT) often reserves port ranges that include Vite's default 5173; see
    // `netsh interface ipv4 show excludedportrange protocol=tcp`. Default to 5300, let WEB2TERM_DEV_PORT
    // override it, and fall through to the next free port instead of failing when it is taken.
    // electron-vite hands the port actually used to Electron, so nothing else pins it.
    server: { host: '127.0.0.1', port: Number(process.env.WEB2TERM_DEV_PORT) || 5300, strictPort: false },
    resolve: {
      alias: {
        '@renderer': resolve(__dirname, 'src/renderer/src'),
        '@shared': resolve(__dirname, 'src/shared')
      }
    },
    plugins: [react(), {
      name: 'bundled-pdf-assets',
      async generateBundle() {
        for (const [name, asset] of Object.entries(PDF_ASSETS)) {
          const root = dirname(dirname(resolvePackage.resolve(asset.package)))
          this.emitFile({ type: 'asset', fileName: `pdf-assets/${name}`, source: await readFile(resolve(root, asset.file)) })
        }
      }
    }],
    build: {
      // electron-vite leaves minification off by default for all three targets.
      // The renderer ships to users, so minify it; main/preload stay readable
      // (they are only a couple of kB and readable stack traces are worth more).
      minify: 'esbuild',
      rollupOptions: {
        // Independent workspace, read-only task overlay and startup splash entries.
        input: {
          index: resolve(__dirname, 'src/renderer/index.html'),
          overlay: resolve(__dirname, 'src/renderer/overlay.html'),
          // Lives in the renderer root so the dev server serves it at /splash.html too.
          splash: resolve(__dirname, 'src/renderer/splash.html')
        }
      }
    }
  }
})

export default defineConfig(async ({ command }) => {
  await configureWindowsDevelopmentRuntime(command, __dirname, () => resolvePackage('electron') as string)
  return config
})
