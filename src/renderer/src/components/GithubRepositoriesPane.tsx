import { useEffect, useRef, useState } from 'react'
import type { JSX } from 'react'
import type { GithubCliState, GithubLoginTaskResult, GithubLogoutResult } from '@shared/github'
import type { BackgroundTask } from '@shared/background-tasks'
import type { CommandRecoveryState } from '@shared/types'
import { githubLoginProgress, isGithubLoginTask } from '../github-login-progress'
import { focusOwnerKey } from '@shared/focus-chat'
import type { FocusOwner } from '@shared/focus-chat'
import GitHubIcon from './GitHubIcon'
import GithubRepositoryList from './GithubRepositoryList'
import { DEFAULT_GITHUB_FILTERS, GithubRepositoryLoadError, loadGithubRepositories } from '../github-repositories'
import type { GithubRepositoryFilters, GithubRepositorySnapshot } from '../github-repositories'
import './GithubRepositoriesPane.css'

interface Props {
  visible: boolean
  owner: FocusOwner
  taskRunning: boolean
  commandRecovery?: CommandRecoveryState | null
  loginDisabledReason: string | null
}

export default function GithubRepositoriesPane({ visible, owner, taskRunning, commandRecovery, loginDisabledReason }: Props): JSX.Element {
  const [state, setState] = useState<GithubCliState | null>(null)
  const [checking, setChecking] = useState(true)
  const [revision, setRevision] = useState(0)
  const [failure, setFailure] = useState('')
  const [actionError, setActionError] = useState('')
  const [copied, setCopied] = useState<string | null>(null)
  const [repositories, setRepositories] = useState<GithubRepositorySnapshot>({ repositories: [], totalCount: null, complete: false })
  const [loadingRepositories, setLoadingRepositories] = useState(false)
  const [repositoryError, setRepositoryError] = useState('')
  const [filters, setFilters] = useState<GithubRepositoryFilters>(DEFAULT_GITHUB_FILTERS)
  const [loggingOut, setLoggingOut] = useState(false)
  const [accountMessage, setAccountMessage] = useState<GithubLogoutResult | null>(null)
  const [sendingLogin, setSendingLogin] = useState(false)
  const [loginRequested, setLoginRequested] = useState(false)
  const [loginResult, setLoginResult] = useState<GithubLoginTaskResult | null>(null)
  const [loginTask, setLoginTask] = useState<BackgroundTask>()
  const [retryingFormat, setRetryingFormat] = useState(false)
  const [loginCheckError, setLoginCheckError] = useState('')
  const mounted = useRef(false)
  const logoutPending = useRef(false)
  const loginPending = useRef(false)
  const loginContext = useRef<{ owner: FocusOwner; since: number; taskId?: string; recoveryToken?: number } | null>(null)
  const cancelLoad = useRef<(() => void) | null>(null)
  const currentOwner = useRef(owner)
  currentOwner.current = owner
  const ownerKey = focusOwnerKey(owner)
  const currentRecovery = loginRequested && commandRecovery?.token !== loginContext.current?.recoveryToken ? commandRecovery : null
  const progress = loginRequested ? loginCheckError && !currentRecovery
    ? { label: '登录状态需要确认', message: loginCheckError, error: true }
    : githubLoginProgress(loginTask, currentRecovery, taskRunning) : null

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  useEffect(() => {
    const context = loginContext.current
    if (context && context.owner.sessionId === owner.sessionId && context.owner.platformId === owner.platformId &&
      (context.owner.conversationId === owner.conversationId || context.owner.conversationId === null)) {
      // Bind the one home -> conversation transition, then require that exact conversation.
      context.owner = { ...owner }
      return
    }
    loginContext.current = null
    setLoginResult(null)
    setLoginRequested(false)
    setLoginTask(undefined)
    setLoginCheckError('')
  }, [ownerKey])

  useEffect(() => {
    if (!loginRequested) return
    let cancelled = false
    let received = false
    const accept = (tasks: BackgroundTask[]): void => {
      const context = loginContext.current
      if (cancelled || !context) return
      const candidates = tasks.filter(item => isGithubLoginTask(item, context.owner.conversationId, context.since))
        .sort((a, b) => a.createdAt - b.createdAt)
      let task = context.taskId ? tasks.find(item => item.id === context.taskId) : candidates[0]
      if (task && ['completed', 'failed', 'exited'].includes(task.status)) {
        task = candidates.find(item => item.createdAt > task!.createdAt) ?? task
      }
      if (task) { context.taskId = task.id; setLoginTask(task) }
    }
    const off = window.api.onBackgroundTasksChanged((next, sessionId) => {
      if (sessionId !== owner.sessionId || cancelled) return
      received = true
      accept(next.tasks)
    })
    void window.api.getBackgroundTasks(owner.sessionId).then(next => { if (!received) accept(next.tasks) }).catch(() => {})
    return () => { cancelled = true; off() }
  }, [loginRequested, ownerKey])

  useEffect(() => { setLoginCheckError('') }, [loginTask?.id])

  useEffect(() => {
    if (!visible) return
    let cancelled = false
    const cancel = (): void => { cancelled = true }
    cancelLoad.current = cancel
    setChecking(true)
    setState(null)
    setFailure('')
    setActionError('')
    setCopied(null)
    setRepositories({ repositories: [], totalCount: null, complete: false })
    setRepositoryError('')
    setLoadingRepositories(false)
    const load = async (): Promise<void> => {
      let cli: GithubCliState | null = null
      try {
        cli = await window.api.getGithubCliState()
        if (cancelled) return
        setState(cli)
        setChecking(false)
        if (cli.status !== 'signed-in' || !cli.account) return
        setLoginRequested(false)
        setLoadingRepositories(true)
        await loadGithubRepositories(cli.account, request => window.api.getGithubRepositoryPage(request),
          snapshot => { if (!cancelled) setRepositories(snapshot) }, () => cancelled)
      } catch (error) {
        if (cancelled) return
        if (cli?.status === 'signed-in') {
          if (error instanceof GithubRepositoryLoadError && error.code === 'auth') {
            setRepositories({ repositories: [], totalCount: null, complete: false })
            setState({ ...cli, status: 'signed-out', account: null, message: error.message })
          } else if (error instanceof GithubRepositoryLoadError && error.code === 'account-changed') {
            setRepositories({ repositories: [], totalCount: null, complete: false })
            setState(null)
            setFailure(error.message)
          } else {
            setRepositoryError(error instanceof GithubRepositoryLoadError ? error.message : '仓库列表加载失败，请刷新重试。')
          }
        } else setFailure('暂时无法检测 GitHub CLI，请重新检测。')
      } finally {
        if (!cancelled) { setChecking(false); setLoadingRepositories(false) }
      }
    }
    void load()
    return () => { cancel(); if (cancelLoad.current === cancel) cancelLoad.current = null }
  }, [visible, revision])

  // The browser may complete authorization before the AI finishes its reply. Recheck on
  // return and task completion, without repeatedly hitting GitHub during device authorization.
  useEffect(() => {
    if (!visible || !loginRequested || sendingLogin || loggingOut) return
    let cancelled = false
    let checkingLogin = false
    const check = async (): Promise<void> => {
      if (checkingLogin) return
      checkingLogin = true
      try {
        const next = await window.api.getGithubCliState()
        if (!cancelled && next.status === 'signed-in') {
          setLoginRequested(false)
          setLoginResult(null)
          setRevision(value => value + 1)
        } else if (!cancelled && loginTask?.status === 'completed') {
          setLoginCheckError('登录进程已结束，但尚未确认可用的 GitHub 登录状态。请查看 AI 回复或重新检测。')
        }
      } catch {
        if (!cancelled && loginTask?.status === 'completed') setLoginCheckError('暂时无法确认 GitHub 登录状态，请重新检测。')
      }
      finally { checkingLogin = false }
    }
    if (!taskRunning || (loginTask && ['completed', 'failed', 'exited'].includes(loginTask.status))) void check()
    const onFocus = (): void => { void check() }
    window.addEventListener('focus', onFocus)
    return () => { cancelled = true; window.removeEventListener('focus', onFocus) }
  }, [visible, loginRequested, sendingLogin, loggingOut, taskRunning, ownerKey, loginTask?.id, loginTask?.status])

  const requestLogin = async (): Promise<void> => {
    if (loginPending.current || loginDisabledReason || loginResult?.status === 'uncertain') return
    loginPending.current = true
    setSendingLogin(true)
    setActionError('')
    setAccountMessage(null)
    setLoginResult(null)
    const source = { ...owner }
    const context = { owner: source, since: Date.now(), recoveryToken: commandRecovery?.token }
    loginContext.current = context
    setLoginTask(undefined)
    setLoginCheckError('')
    try {
      const result = await window.api.requestGithubLogin(source)
      const current = currentOwner.current
      // A home-page send can bind a new conversation; an existing chat may not change owners.
      if (!mounted.current || loginContext.current !== context || context.owner.sessionId !== current.sessionId ||
        context.owner.platformId !== current.platformId ||
        (context.owner.conversationId !== null && context.owner.conversationId !== current.conversationId)) return
      setLoginResult(result)
      if (result.status === 'sent') setLoginRequested(true)
      if (result.status === 'already-signed-in') setRevision(value => value + 1)
    } catch {
      if (mounted.current && loginContext.current === context &&
        (focusOwnerKey(currentOwner.current) === focusOwnerKey(context.owner) ||
          (context.owner.conversationId === null && currentOwner.current.sessionId === source.sessionId && currentOwner.current.platformId === source.platformId))) {
        setLoginResult({ status: 'uncertain', message: '发送结果尚未确认，请先查看当前对话，避免重复发送。' })
      }
    } finally {
      loginPending.current = false
      if (mounted.current) setSendingLogin(false)
    }
  }

  const retryFormat = async (): Promise<void> => {
    if (!currentRecovery || retryingFormat) return
    setRetryingFormat(true)
    setActionError('')
    try {
      const result = await window.api.retryCommandRecovery(owner, currentRecovery.token)
      if (mounted.current && result !== 'ok') setActionError(result === 'stuck'
        ? '发送结果尚未确认，请先在原始视图核对。' : '修正请求未发送，请处理网页草稿并恢复自动执行后重试。')
    } catch { if (mounted.current) setActionError('发送结果未确认，请先在原始视图核对。') }
    finally { if (mounted.current) setRetryingFormat(false) }
  }

  const logout = async (): Promise<void> => {
    if (!state?.account || logoutPending.current) return
    const account = state.account
    logoutPending.current = true
    setLoggingOut(true)
    try {
      const result = await window.api.logoutGithubCli(account)
      if (!mounted.current) return
      cancelLoad.current?.()
      setLoadingRepositories(false)
      setAccountMessage(result)
      setLoginResult(null)
      setLoginRequested(false)
      if (result.ok) {
        setRepositories({ repositories: [], totalCount: null, complete: false })
        setFilters(DEFAULT_GITHUB_FILTERS)
        setState(null)
        setChecking(true)
      }
      // A fresh check also covers gh selecting another saved account after logout.
      setRevision(value => value + 1)
    } catch {
      if (mounted.current) setAccountMessage({ ok: false, message: '退出登录未完成，请重新检测账号状态后重试。' })
    } finally {
      logoutPending.current = false
      if (mounted.current) setLoggingOut(false)
    }
  }
  const refresh = (): void => { setAccountMessage(null); setLoginResult(null); setRevision(value => value + 1) }

  const copyCommand = async (command: string): Promise<void> => {
    setActionError('')
    try { await navigator.clipboard.writeText(command); setCopied(command) }
    catch { setActionError('复制失败，请选择并复制上方命令。') }
  }
  const openInstall = async (): Promise<void> => {
    setActionError('')
    try { await window.api.openGithubCliInstall() }
    catch { setActionError('安装页面未能打开，请在浏览器中访问 https://cli.github.com/。') }
  }
  const installLabel = checking ? '检测中…' : state?.status === 'missing' ? '未安装'
    : state?.version ? `已安装 · ${state.version}` : '检测失败'
  const accountLabel = checking || state?.status === 'missing' ? '等待检测'
    : state?.status === 'signed-in' ? `已登录 · @${state.account}` : state?.status === 'signed-out' ? '未登录' : '检测失败'

  return <section className="panel__view github-repositories-pane" hidden={!visible} aria-label="GitHub 仓库管理" aria-busy={checking || loadingRepositories || loggingOut || sendingLogin}>
    {!checking && state?.status === 'signed-in' && state.account ? <GithubRepositoryList sessionId={owner.sessionId} account={state.account}
      visible={visible}
      snapshot={repositories} loading={loadingRepositories} error={repositoryError} filters={filters}
      loggingOut={loggingOut} accountMessage={accountMessage} onLogout={() => void logout()}
      onFiltersChange={setFilters} onRefresh={refresh} /> : <div className="github-repositories-pane__empty">
      <span className="github-repositories-pane__icon" aria-hidden="true">
        <GitHubIcon size={28} />
      </span>
      <h2>GitHub 仓库管理</h2>
      <p className="github-repositories-pane__status" role="status">
        {checking ? '正在检查本机 GitHub CLI 和登录状态…' : failure || state?.message}
      </p>
      {accountMessage ? <p className={accountMessage.ok ? 'github-repositories-pane__hint' : 'github-repositories-pane__error'} role={accountMessage.ok ? 'status' : 'alert'}>{accountMessage.message}</p> : null}
      <div className="github-repositories-pane__setup">
        <dl className="github-repositories-pane__checks">
          <div><dt>GitHub CLI</dt><dd>{installLabel}</dd></div>
          <div><dt>GitHub 账号</dt><dd>{accountLabel}</dd></div>
        </dl>
        {!checking && state?.status === 'missing' ? <div className="github-repositories-pane__guide">
          <p>{state.installCommand ? '在本机系统终端中运行以下命令安装：' : '打开官方安装页面，选择当前系统的安装方式。'}</p>
          {state.installCommand ? <>
            <pre><code>{state.installCommand}</code></pre>
            <button type="button" onClick={() => void copyCommand(state.installCommand!)}>{copied === state.installCommand ? '已复制' : '复制安装命令'}</button>
          </> : null}
          <button type="button" onClick={() => void openInstall()}>打开官方安装页面</button>
          <p className="github-repositories-pane__hint">安装完成后重新检测；若仍未识别，请重启应用。</p>
        </div> : null}
        {!checking && state?.status === 'signed-out' ? <div className="github-repositories-pane__guide">
          <button type="button" className="github-repositories-pane__login" title={loginDisabledReason ?? '让当前 AI 协助登录 GitHub'}
            disabled={sendingLogin || !!loginDisabledReason || loginResult?.status === 'uncertain'} onClick={() => void requestLogin()}>
            {sendingLogin ? '发送中…' : progress?.label || '帮我登录'}
          </button>
          {progress?.message ? <p className={progress.error ? 'github-repositories-pane__error' : 'github-repositories-pane__hint'} role="status">{progress.message}</p> : null}
          {currentRecovery && ['blocked', 'failed'].includes(currentRecovery.status)
            ? <button type="button" disabled={retryingFormat} onClick={() => void retryFormat()}>{retryingFormat ? '发送中…' : '重试修正'}</button> : null}
          {loginResult && loginResult.status !== 'sent' ? <p className={loginResult.status === 'blocked' || loginResult.status === 'uncertain' ? 'github-repositories-pane__error' : 'github-repositories-pane__hint'}
            role={loginResult.status === 'blocked' || loginResult.status === 'uncertain' ? 'alert' : 'status'}>{loginResult.message}</p> : null}
        </div> : null}
        {!checking && state?.status === 'error' ? <p className="github-repositories-pane__hint">可在本机终端运行 gh auth status --hostname github.com 查看详情。</p> : null}
        {actionError ? <p className="github-repositories-pane__error" role="alert">{actionError}</p> : null}
        <button type="button" className="github-repositories-pane__refresh" disabled={checking || loggingOut || sendingLogin} onClick={refresh}>
          {checking ? '正在检测…' : state?.status === 'missing' ? '我已安装，重新检测' : state?.status === 'signed-out' ? '我已登录，重新检测' : '重新检测'}
        </button>
      </div>
    </div>}
  </section>
}
