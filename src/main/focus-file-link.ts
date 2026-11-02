import type { WebContents } from 'electron'
import type { FocusFileLinkTarget } from '../shared/focus-file-links'
import { validFocusFileLinkTarget } from '../shared/focus-file-links'
import type { FocusSendOutcome } from '../shared/focus-chat'

/** Dispatch the user's file action inside the authenticated page; never open a sandbox path in the OS. */
export async function openNativeFocusFileLink(contents: WebContents, target: FocusFileLinkTarget,
  isCurrent: () => boolean): Promise<FocusSendOutcome> {
  if (!validFocusFileLinkTarget(target)) return 'invalid'
  if (!isCurrent() || contents.isDestroyed()) return 'cancelled'
  const url = contents.getURL()
  try {
    const outcome = await contents.executeJavaScript('window.__cmdTerminalInterceptor?.openFocusFileLink(' +
      JSON.stringify(target) + ',' + JSON.stringify(new URL(url).pathname) + ')', true)
    if (!isCurrent() || contents.isDestroyed() || contents.getURL() !== url) return 'cancelled'
    return ['ok', 'busy', 'unavailable', 'invalid', 'unknown', 'cancelled'].includes(outcome) ? outcome : 'unavailable'
  } catch { return isCurrent() && !contents.isDestroyed() && contents.getURL() === url ? 'unknown' : 'cancelled' }
}
