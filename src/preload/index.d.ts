import type { AppApi } from '../shared/types'
import type { ComputerOverlayApi } from '../shared/computer-overlay'

declare global {
  interface Window {
    /** Injected by `src/preload/index.ts` via `contextBridge`. */
    api: AppApi
    computerOverlay: ComputerOverlayApi
  }
}

export {}
