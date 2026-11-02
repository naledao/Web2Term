import { app } from 'electron'
import type { BrowserWindow } from 'electron'
import { APP_ID, APP_NAME, APP_DEVELOPMENT_ID, APP_DEVELOPMENT_NAME } from './app-identity'
import { quoteWindowsArgument } from '../shared/windows-command-line'

/** Configure the taskbar identity before the main window is first shown. */
export function configureWindowsAppDetails(window: BrowserWindow): void {
  if (process.platform !== 'win32') return
  window.setAppDetails({
    appId: app.isPackaged ? APP_ID : APP_DEVELOPMENT_ID,
    appIconPath: process.execPath,
    appIconIndex: 0,
    relaunchCommand: [process.execPath, ...(app.isPackaged ? [] : [app.getAppPath()])].map(quoteWindowsArgument).join(' '),
    relaunchDisplayName: app.isPackaged ? APP_NAME : APP_DEVELOPMENT_NAME
  })
}
