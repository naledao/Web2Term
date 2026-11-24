import { useEffect, useRef, useState } from 'react'
import type { AdminAccount } from '../../../../shared/admin'
import AdminFeedback from './AdminFeedback'
import type { FeedbackPreset } from './AdminFeedback'
import AdminMachines from './AdminMachines'
import AdminOverview from './AdminOverview'
import type { AdminJump } from './AdminOverview'
import AdminReleaseNotes from './AdminReleaseNotes'
import type { ReleaseNotesPreset } from './AdminReleaseNotes'
import AdminUsers from './AdminUsers'
import type { UsersPreset } from './AdminUsers'
import './AdminApp.css'

type Section = 'overview' | 'feedback' | 'release-notes' | 'users' | 'machines'
const SECTIONS: { id: Section; label: string }[] = [
  { id: 'overview', label: '概览' }, { id: 'feedback', label: '反馈管理' }, { id: 'release-notes', label: '更新说明' },
  { id: 'users', label: '用户' }, { id: 'machines', label: '机器' }
]

/** Administration window shell. Sections stay mounted while hidden so unsaved edits survive switching. */
export default function AdminApp({ theme }: { theme: 'light' | 'dark' }) {
  const [account, setAccount] = useState<AdminAccount | null | undefined>(undefined)
  const [section, setSection] = useState<Section>('overview')
  const nonce = useRef(0)
  const [feedbackPreset, setFeedbackPreset] = useState<FeedbackPreset | null>(null)
  const [notesPreset, setNotesPreset] = useState<ReleaseNotesPreset | null>(null)
  const [usersPreset, setUsersPreset] = useState<UsersPreset | null>(null)

  const jump = (target: AdminJump): void => {
    const next = ++nonce.current
    if (target.section === 'feedback') setFeedbackPreset({ status: target.status, nonce: next })
    else if (target.section === 'release-notes') setNotesPreset({ status: target.status, nonce: next })
    else if (target.section === 'users') setUsersPreset({ enabled: target.enabled, q: '', nonce: next })
    setSection(target.section)
  }

  useEffect(() => {
    let cancelled = false
    void window.api.getAdminAccount().then(value => { if (!cancelled) setAccount(value) }).catch(() => { if (!cancelled) setAccount(null) })
    return () => { cancelled = true }
  }, [])

  return <div className="admin" data-theme={theme}>
    <aside className="admin__nav" aria-label="管理后台导航">
      <div className="admin__brand"><strong>Web2Term</strong><span>管理后台</span></div>
      <nav>{SECTIONS.map(item => <button key={item.id} type="button" className={section === item.id ? 'is-selected' : ''}
        aria-current={section === item.id ? 'page' : undefined} onClick={() => setSection(item.id)}>{item.label}</button>)}</nav>
      <div className="admin__account">
        {account === undefined ? <span>正在读取账号…</span> : account ? <>
          <span className="admin__account-email" title={account.email}>{account.email}</span>
          <span className="admin__account-server" title={account.backendUrl}>{account.backendUrl}</span>
        </> : <span className="admin__account-warning">未登录，请在主窗口登录管理员账号</span>}
      </div>
    </aside>
    <main className="admin__main">
      <div className="admin__section" hidden={section !== 'overview'}><AdminOverview active={section === 'overview'} onJump={jump} /></div>
      <div className="admin__section" hidden={section !== 'feedback'}><AdminFeedback preset={feedbackPreset} /></div>
      <div className="admin__section" hidden={section !== 'release-notes'}><AdminReleaseNotes theme={theme} preset={notesPreset} /></div>
      <div className="admin__section" hidden={section !== 'users'}>
        <AdminUsers selfEmail={account?.email ?? ''} preset={usersPreset}
          onShowFeedback={email => { setFeedbackPreset({ status: null, q: email, nonce: ++nonce.current }); setSection('feedback') }} />
      </div>
      <div className="admin__section" hidden={section !== 'machines'}><AdminMachines /></div>
    </main>
  </div>
}
