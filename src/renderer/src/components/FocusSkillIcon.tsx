import type { JSX } from 'react'
import type { FocusSkillId } from '@shared/focus-skills'

/** One 24px stroke system, with a distinct silhouette for each composer skill. */
const FOCUS_SKILL_ICON_PATHS: Readonly<Record<FocusSkillId, readonly string[]>> = {
  compact: [
    'M7 4h10a3 3 0 0 1 3 3v7a3 3 0 0 1-3 3H9l-5 3V7a3 3 0 0 1 3-3Z',
    'm8 8 3 3-3 3m8-6-3 3 3 3'
  ],
  scheduled_task: [
    'M10 21H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v2',
    'M7 3v4m8-4v4M3 10h9',
    'M21.5 17a4.5 4.5 0 1 1-9 0 4.5 4.5 0 0 1 9 0Z',
    'M17 14.5V17l1.8 1.1'
  ],
  send_email: [
    'M5 5h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2Z',
    'm3.5 7 7.4 5a2 2 0 0 0 2.2 0l7.4-5'
  ],
  computer: [
    'M12 17H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v5',
    'M8 21h6m-3-4v4',
    'm15 11 6.5 4.4-3.1.8-1.3 3.3L15 11Z'
  ]
}

export default function FocusSkillIcon({ skill }: { skill: FocusSkillId }): JSX.Element {
  return <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="1.75"
    strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
    {FOCUS_SKILL_ICON_PATHS[skill].map((path, index) => <path key={index} d={path} />)}
  </svg>
}
