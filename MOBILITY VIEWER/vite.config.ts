import { defineConfig, loadEnv, type PluginOption } from 'vite'
import react from '@vitejs/plugin-react'
import { viteCommonjs } from '@originjs/vite-plugin-commonjs'

const env = loadEnv(process.env.NODE_ENV ?? 'development', process.cwd(), '')
for (const [key, value] of Object.entries(env)) {
  process.env[key] ??= value
}
const dicomwebPacsRoot = process.env.DICOMWEB_PACS_ROOT ?? 'http://127.0.0.1:5001'
process.env.VITE_APP_BASE_PATH ??= ''

// These modules only register handlers when Vite invokes configureServer.
// Loading them here keeps the command detection reliable for both `vite` and
// `vite serve`; process.argv does not contain "serve" for the default command.
// @ts-ignore - Node ESM middleware is shared with the production server.
const { handleAuthApi } = await import('./server/authApi.mjs')
// @ts-ignore - Node ESM middleware is shared with the production server.
const { handleMprApi } = await import('./server/mprEngine/mprApi.mjs')

export default defineConfig(({ command, mode }) => {
  void mode
  const plugins: PluginOption[] = [react(), viteCommonjs()]
  if (command === 'serve') plugins.unshift(viewerApiPlugin(handleAuthApi, handleMprApi, dicomwebPacsRoot))

  return {
    base: './',
    plugins,
    server: {
      host: '0.0.0.0',
      port: 5992,
      proxy: {
        '/rs': {
          target: dicomwebPacsRoot,
          changeOrigin: true,
        },
        '/wadouri': {
          target: dicomwebPacsRoot,
          changeOrigin: true,
        },
        '/api/viewer': {
          target: dicomwebPacsRoot,
          changeOrigin: true,
        },
      },
    },
    optimizeDeps: {
      exclude: ['@cornerstonejs/dicom-image-loader'],
      include: ['dicom-parser'],
    },
    worker: {
      format: 'es',
      rollupOptions: {
        external: ['@icr/polyseg-wasm'],
      },
    },
  }
})

function viewerApiPlugin(
  handleAuthApi: (req: any, res: any) => Promise<boolean>,
  handleMprApi: (req: any, res: any, dicomwebBase: string) => Promise<boolean>,
  dicomwebPacsRoot: string,
) {
  return {
    name: 'vexa-mobile-viewer-api',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        if (await handleAuthApi(req, res)) return
        if (await handleMprApi(req, res, new URL(dicomwebPacsRoot).origin)) return
        next()
      })
    },
  }
}
