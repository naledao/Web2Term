import { existsSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { app, shell } from 'electron'
import type { ShortcutDetails } from 'electron'
import { APP_ID, APP_NAME } from './app-identity'

const legacyShortcutName = /^GPT Web to Codex Terminal(?: \(\d+\))?\.lnk$/i
const knownExecutableName = /^(?:GPT Web to Codex Terminal|Web2Term)\.exe$/i

/** Run before the first toast, after setting the process AUMID. */
export function repairWindowsNotificationShortcuts(): void {
  // Development has its own identity and must never take over installed shortcuts.
  if (process.platform !== 'win32' || !app.isPackaged) return
  const programs = join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs')
  const canonical = join(programs, `${APP_NAME}.lnk`)
  try {
    let existing: ShortcutDetails | undefined
    if (existsSync(canonical)) {
      existing = shell.readShortcutLink(canonical)
      if (existing.appUserModelId !== APP_ID) {
        console.warn('[notification] Web2Term shortcut belongs to another application; leaving it unchanged')
        return
      }
    }
    const desired: ShortcutDetails = {
      target: process.execPath, cwd: dirname(process.execPath), args: '', description: APP_NAME,
      icon: process.execPath, iconIndex: 0, appUserModelId: APP_ID,
      // Retain Electron's persisted activator so notifications already in Action Center still work.
      toastActivatorClsid: existing?.toastActivatorClsid || app.toastActivatorCLSID
    }
    // Avoid rewriting a healthy link on every startup. Electron may otherwise create
    // a replacement without an explicit icon after the executable/product rename.
    if (!existing || Object.entries(desired).some(([key, value]) => existing[key as keyof ShortcutDetails] !== value)) {
      mkdirSync(programs, { recursive: true })
      if (!shell.writeShortcutLink(canonical, existing ? 'update' : 'create', desired)) {
        console.warn('[notification] could not repair the Web2Term Start Menu shortcut')
        return
      }
    }
  } catch (error) {
    console.warn('[notification] could not repair the Web2Term Start Menu shortcut:', error)
    return
  }

  // Windows can resolve the stable AUMID to an orphaned pre-rename shortcut even
  // when Web2Term.lnk exists. Only remove known, broken links with our exact AUMID,
  // and only after a working replacement has been ensured above.
  const removeOrphans = (directory: string): void => {
    try {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (entry.isSymbolicLink()) continue
        const path = join(directory, entry.name)
        if (entry.isDirectory()) {
          removeOrphans(path)
        } else if (entry.isFile() && legacyShortcutName.test(entry.name)) {
          try {
            const shortcut = shell.readShortcutLink(path)
            if (shortcut.appUserModelId === APP_ID && isAbsolute(shortcut.target)
              && knownExecutableName.test(basename(shortcut.target)) && !existsSync(shortcut.target)) {
              unlinkSync(path)
              console.info('[notification] removed an orphaned pre-rename Start Menu shortcut')
            }
          } catch (error) {
            console.warn('[notification] could not inspect or remove a legacy Start Menu shortcut:', error)
          }
        }
      }
    } catch (error) {
      console.warn('[notification] could not inspect Start Menu shortcuts:', error)
    }
  }
  removeOrphans(programs)
}
