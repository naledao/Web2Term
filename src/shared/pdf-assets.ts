export const PDF_ASSET_SCHEME = 'pdf-asset'
export const PDF_ASSET_ORIGIN = `${PDF_ASSET_SCHEME}://viewer`

/** Only these bundled, public viewer resources are exposed by the asset protocol. */
export const PDF_ASSETS: Record<string, { package: string; file: string; mime: string }> = {
  'pdfium.wasm': { package: '@embedpdf/pdfium', file: 'dist/pdfium.wasm', mime: 'application/wasm' },
  'latin.ttf': { package: '@embedpdf/fonts-latin', file: 'fonts/NotoSans-Regular.ttf', mime: 'font/ttf' },
  'chinese.otf': { package: '@embedpdf/fonts-sc', file: 'fonts/NotoSansHans-Regular.otf', mime: 'font/otf' },
  'traditional.otf': { package: '@embedpdf/fonts-tc', file: 'fonts/NotoSansHant-Regular.otf', mime: 'font/otf' },
  'embedpdf-license.txt': { package: '@embedpdf/react-pdf-viewer', file: 'LICENSE', mime: 'text/plain' },
  'pdfium-license.txt': { package: '@embedpdf/pdfium', file: 'LICENSE.pdfium', mime: 'text/plain' },
  'latin-license.txt': { package: '@embedpdf/fonts-latin', file: 'LICENSE', mime: 'text/plain' },
  'chinese-license.txt': { package: '@embedpdf/fonts-sc', file: 'LICENSE', mime: 'text/plain' },
  'traditional-license.txt': { package: '@embedpdf/fonts-tc', file: 'LICENSE', mime: 'text/plain' }
}
