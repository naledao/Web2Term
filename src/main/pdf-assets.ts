import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { app, protocol } from 'electron'
import { PDF_ASSETS, PDF_ASSET_SCHEME } from '../shared/pdf-assets'

export function registerPdfAssetScheme(): void {
  protocol.registerSchemesAsPrivileged([{
    scheme: PDF_ASSET_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true }
  }])
}

/** Supports fetch/XHR from workers in both Vite dev and packaged file:// windows. */
export function registerPdfAssetHandler(): void {
  const resolvePackage = createRequire(join(app.getAppPath(), 'package.json'))
  protocol.handle(PDF_ASSET_SCHEME, async (request) => {
    const url = new URL(request.url)
    const name = url.pathname.slice(1)
    if (url.host !== 'viewer' || url.username || url.password || request.method !== 'GET' || !Object.hasOwn(PDF_ASSETS, name)) {
      return new Response('Not found', { status: 404 })
    }
    const asset = PDF_ASSETS[name]
    try {
      const filename = app.isPackaged
        ? join(__dirname, '../renderer/pdf-assets', name)
        : join(dirname(dirname(resolvePackage.resolve(asset.package))), asset.file)
      const bytes = await readFile(filename)
      return new Response(new Uint8Array(bytes), { headers: {
        'Content-Type': asset.mime,
        'Access-Control-Allow-Origin': '*',
        'Cross-Origin-Resource-Policy': 'cross-origin',
        'Cache-Control': 'no-store'
      } })
    } catch {
      return new Response('PDF resource unavailable', { status: 404 })
    }
  })
}
