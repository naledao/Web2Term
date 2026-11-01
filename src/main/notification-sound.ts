import { execFile } from 'node:child_process'
import { copyFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { app } from 'electron'

/** A native toast sound event keeps Windows in charge of per-app mute and Do Not Disturb. */
export async function registerNotificationSound(): Promise<string | undefined> {
  if (process.platform !== 'win32') return undefined
  const event = `Notification.Web2Term.WoodDrop${app.isPackaged ? '' : '.Development'}`
  const schemes = 'HKCU\\AppEvents\\Schemes'
  const key = `${schemes}\\Apps\\.Default\\${event}`
  const registry = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'reg.exe')
  const run = (args: string[]): Promise<{ ok: boolean; stdout: string }> => new Promise(resolve => {
    execFile(registry, args, { windowsHide: true, encoding: 'utf8', timeout: 3000, maxBuffer: 16 * 1024 },
      (error, stdout) => resolve({ ok: !error, stdout }))
  })
  const setDefault = async (path: string, value: string): Promise<void> => {
    const result = await run(['add', path, '/ve', '/t', 'REG_SZ', '/d', value, '/f'])
    if (!result.ok) throw new Error('Could not register notification sound event')
  }
  try {
    // Use a stable path outside app.asar; Windows, rather than Electron, reads the WAV.
    const directory = join(app.getPath('userData'), 'sounds')
    const file = 'notification-wood-drop.wav'
    const source = app.isPackaged ? join(process.resourcesPath, file) : join(app.getAppPath(), 'build', file)
    await mkdir(directory, { recursive: true })
    const destination = join(directory, file)
    await copyFile(source, destination)

    const current = await run(['query', `${key}\\.Current`, '/ve'])
    if (!current.ok) {
      const activeScheme = await run(['query', schemes, '/ve'])
      const scheme = activeScheme.ok ? /\bREG_SZ\s+([^\r\n]+)/.exec(activeScheme.stdout)?.[1].trim() : undefined
      if (!scheme) throw new Error('Could not read active Windows sound scheme')
      // Installing an event must not turn sound back on under the "No Sounds" scheme.
      await setDefault(`${key}\\.Current`, scheme.toLowerCase() === '.none' ? '' : destination)
    }
    // Existing .Current values, including an explicit empty/muted value, belong to the user.
    await setDefault(`${key}\\.Default`, destination)
    await setDefault(`HKCU\\AppEvents\\EventLabels\\${event}`, 'Web2Term - Wood drop')
    return `ms-winsoundevent:${event}`
  } catch (error) {
    console.warn('[notification] could not register wood-drop sound; using the system notification sound:', error)
    return undefined
  }
}
