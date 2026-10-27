import { contextBridge, ipcRenderer } from 'electron'
import type { IpcRendererEvent } from 'electron'
import { COMPUTER_OVERLAY_GET, COMPUTER_OVERLAY_CHANGED, COMPUTER_OVERLAY_FIT } from '../shared/computer-overlay'
import type { ComputerOverlayApi, ComputerOverlaySnapshot } from '../shared/computer-overlay'

const api: ComputerOverlayApi = {
  getSnapshot: () => ipcRenderer.invoke(COMPUTER_OVERLAY_GET),
  onChanged: listener => {
    const handler = (_event: IpcRendererEvent, snapshot: ComputerOverlaySnapshot | null): void => listener(snapshot)
    ipcRenderer.on(COMPUTER_OVERLAY_CHANGED, handler)
    return () => { ipcRenderer.removeListener(COMPUTER_OVERLAY_CHANGED, handler) }
  },
  fitContent: size => { ipcRenderer.send(COMPUTER_OVERLAY_FIT, size) }
}
contextBridge.exposeInMainWorld('computerOverlay', api)
