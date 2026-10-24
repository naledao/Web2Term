import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'

export const APP_NAME = 'Web2Term'

// Keep the installed application identity stable so upgrades, shortcuts and
// Windows notifications still belong to the same application.
export const APP_ID = 'com.example.gptweb2codexterminal'

const LEGACY_PRODUCT_NAME = 'GPT Web to Codex Terminal'
const LEGACY_PACKAGE_NAME = 'gpt-web-to-codex-terminal'

/** Run before logging, single-instance locking or creating any Electron session. */
export function configureAppIdentity(): void {
  const appData = app.getPath('appData')
  const legacyNames = app.isPackaged
    ? [LEGACY_PRODUCT_NAME, LEGACY_PACKAGE_NAME]
    : [LEGACY_PACKAGE_NAME, LEGACY_PRODUCT_NAME]
  const candidates = [APP_NAME, ...legacyNames].map(name => join(appData, name))

  // Electron can create an empty directory under the new name before we run.
  // Prefer an existing database over an empty directory to retain conversations,
  // settings and the cookies/encryption state stored alongside them. Reuse the
  // directory in place instead of copying or moving a potentially open profile.
  const userData = candidates.find(path => existsSync(join(path, 'conversations.db')))
    ?? candidates.find(path => existsSync(path))
    ?? candidates[0]

  mkdirSync(userData, { recursive: true })
  app.setName(APP_NAME)
  app.setPath('userData', userData)
  app.setPath('sessionData', userData)
}
