import { useId, useState } from 'react'

type Visibility =
  | { status: 'hidden' | 'loading' | 'error' }
  | { status: 'visible'; savedPassword?: string }

interface SshPasswordFieldProps {
  password: string
  savedHostId: string | null
  onChange: (password: string) => void
}

export default function SshPasswordField({ password, savedHostId, onChange }: SshPasswordFieldProps) {
  const inputId = useId()
  const errorId = `${inputId}-error`
  const [visibility, setVisibility] = useState<Visibility>({ status: 'hidden' })
  const visible = visibility.status === 'visible'
  const loading = visibility.status === 'loading'

  async function toggleVisibility(): Promise<void> {
    if (visible) {
      setVisibility({ status: 'hidden' })
      return
    }
    if (password !== '') {
      setVisibility({ status: 'visible' })
      return
    }
    if (savedHostId === null || loading) return

    const request = { status: 'loading' } as const
    setVisibility(request)
    const savedPassword = await window.api.getSavedSshPassword(savedHostId).catch(() => null)
    // An edit during the request takes precedence over its result.
    setVisibility((current) => {
      if (current !== request) return current
      return savedPassword === null ? { status: 'error' } : { status: 'visible', savedPassword }
    })
  }

  return (
    <div className="ssh-connect__field">
      <label className="ssh-connect__password-label" htmlFor={inputId}>密码</label>
      <div className="ssh-connect__password">
        <input
          id={inputId}
          className="ssh-connect__input"
          type={visible ? 'text' : 'password'}
          value={visibility.status === 'visible' ? visibility.savedPassword ?? password : password}
          placeholder={savedHostId ? '留空 = 使用这台主机已保存的密码' : '请输入 SSH 密码'}
          aria-describedby={visibility.status === 'error' ? errorId : undefined}
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => {
            const next = event.currentTarget.value
            onChange(next)
            if (visibility.status !== 'hidden') {
              setVisibility({ status: visible && next !== '' ? 'visible' : 'hidden' })
            }
          }}
        />
        <button
          type="button"
          className="ssh-connect__password-toggle"
          aria-controls={inputId}
          aria-label={loading ? '正在读取密码' : visible ? '隐藏密码' : '显示密码'}
          disabled={loading || (!visible && password === '' && savedHostId === null)}
          onClick={() => void toggleVisibility()}
        >
          {loading ? '读取中' : visible ? '隐藏' : '显示'}
        </button>
      </div>
      {visibility.status === 'error' ? (
        <p id={errorId} className="ssh-connect__password-error" role="alert">无法读取已保存的密码，请重试或重新输入。</p>
      ) : null}
    </div>
  )
}
