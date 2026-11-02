import type { JSX } from 'react'
import { FOCUS_SKILLS, validFocusToolSkills } from '@shared/focus-skills'
import type { FocusToolSkill } from '@shared/focus-skills'
import FocusSkillIcon from './FocusSkillIcon'

/** Read-only references on one sent message, separate from the editable draft. */
export default function FocusMessageSkills({ skills }: { skills?: FocusToolSkill[] }): JSX.Element | null {
  if (!validFocusToolSkills(skills) || !skills.length) return null
  return <ul className="focus-user__skills" aria-label="引用的技能">
    {skills.map(id => <li key={id}><FocusSkillIcon skill={id} /><span>{FOCUS_SKILLS.find(skill => skill.id === id)!.name}</span></li>)}
  </ul>
}
