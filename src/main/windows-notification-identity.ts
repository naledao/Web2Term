import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, unlinkSync } from 'node:fs'
import { copyFile, mkdir } from 'node:fs/promises'
import { dirname, isAbsolute, join, normalize } from 'node:path'
import { app, shell } from 'electron'
import type { ShortcutDetails } from 'electron'
import { APP_ID, APP_DEVELOPMENT_ID, APP_DEVELOPMENT_NAME } from './app-identity'
import { quoteWindowsArgument } from '../shared/windows-command-line'

const validActivator = (value: string | undefined): value is string =>
  /^\{[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\}$/i.test(value ?? '')
const samePath = (left: string, right: string): boolean => isAbsolute(left) &&
  normalize(left).toLowerCase() === normalize(right).toLowerCase()

/** Register the same development identity used by the branded runtime and taskbar. */
export async function registerWindowsDevelopmentNotificationIdentity(): Promise<void> {
  if (process.platform !== 'win32' || app.isPackaged) return
  try {
    const programs = join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs')
    const canonical = join(programs, `${APP_DEVELOPMENT_NAME}.lnk`)
    const existing = existsSync(canonical) ? shell.readShortcutLink(canonical) : undefined
    if (existing && existing.appUserModelId !== APP_DEVELOPMENT_ID) {
      console.warn('[notification] the development shortcut belongs to another application; leaving it unchanged')
      return
    }
    const oldPath = join(programs, 'Electron.lnk')
    let old: ShortcutDetails | undefined
    try {
      if (existsSync(oldPath)) {
        const shortcut = shell.readShortcutLink(oldPath)
        const source = process.env.WEB2TERM_DEV_ELECTRON_SOURCE || join(app.getAppPath(), 'node_modules', 'electron', 'dist', 'electron.exe')
        if ([APP_ID, APP_DEVELOPMENT_ID].includes(shortcut.appUserModelId ?? '') && samePath(shortcut.target, source)) old = shortcut
      }
    } catch (error) { console.warn('[notification] could not inspect the legacy development shortcut:', error) }
    const activator = validActivator(existing?.toastActivatorClsid) ? existing.toastActivatorClsid :
      validActivator(old?.toastActivatorClsid) ? old.toastActivatorClsid : app.toastActivatorCLSID
    // Native Electron will adopt this CLSID from its ProductName-based shortcut.
    app.setToastActivatorCLSID(activator)
    const desired: ShortcutDetails = { target: process.execPath, cwd: dirname(process.execPath),
      args: quoteWindowsArgument(app.getAppPath()), description: APP_DEVELOPMENT_NAME,
      icon: process.execPath, iconIndex: 0, appUserModelId: APP_DEVELOPMENT_ID, toastActivatorClsid: activator }
    if (!existing || Object.entries(desired).some(([key, value]) => existing[key as keyof ShortcutDetails] !== value)) {
      mkdirSync(programs, { recursive: true })
      if (!shell.writeShortcutLink(canonical, existing ? 'update' : 'create', desired)) {
        console.warn('[notification] could not create or repair the branded development shortcut')
        return
      }
    }
    // Only retire the legacy link after the branded replacement exists, and only
    // when its AUMID and original project runtime match. Installed links are separate.
    if (old) {
      try { unlinkSync(oldPath) } catch (error) { console.warn('[notification] could not retire the legacy development shortcut:', error) }
    }
    // Windows reads the icon directly. Keep a stable PNG outside node_modules and
    // build output so dependency reinstalls do not invalidate the registered icon.
    const directory = join(app.getPath('userData'), 'notifications', 'development')
    const icon = join(directory, 'icon.png')
    await mkdir(directory, { recursive: true })
    await copyFile(join(app.getAppPath(), 'build', 'icon.png'), icon)
    const key = `HKCU\\Software\\Classes\\AppUserModelId\\${APP_DEVELOPMENT_ID}`
    const registry = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'reg.exe')
    const values = [['DisplayName', 'REG_EXPAND_SZ', APP_DEVELOPMENT_NAME], ['IconUri', 'REG_EXPAND_SZ', icon],
      ['CustomActivator', 'REG_SZ', activator]]
    for (const [name, type, value] of values) {
      await new Promise<void>((resolve, reject) => {
        execFile(registry, ['add', key, '/v', name, '/t', type, '/d', value, '/f'],
          { windowsHide: true, encoding: 'utf8', timeout: 3000, maxBuffer: 16 * 1024 },
          error => error ? reject(error) : resolve())
      })
    }
  } catch (error) {
    console.warn('[notification] could not register the Web2Term development identity:', error)
  }
}
