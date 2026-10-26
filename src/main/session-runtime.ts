import { randomUUID } from 'node:crypto'
import { validFocusUiAction } from '../shared/focus-smart-ui'
import type { FocusUiRequest } from '../shared/focus-smart-ui'
import type { FocusComposerModeRequest, FocusModelSettingsRequest, FocusModelSettingsResult } from '../shared/focus-chat'
import { validFocusModelSettingsRequest } from '../shared/focus-chat'
import { writeFile } from 'node:fs/promises'
import { createConnection } from 'mysql2/promise'
import { formatMysqlCell } from './mysql-field-value'
import type { Connection } from 'mysql2/promise'
import { app, BrowserWindow, dialog, Notification, safeStorage } from 'electron'
import { writeCommandDiagnostic } from './command-log'
import type { CommandDiagnostic } from './command-log'
import {
  FALLBACK_ENVIRONMENT,
  IpcChannels,
  buildTerminalPromptParts,
  toolPromptForPlatform,
  fileReadingPlatform,
  canEditTerminalNotes,
  terminalNotesOwnerKey
} from '../shared/types'
import { CHAT_PLATFORMS, DEEPSEEK_PLATFORM } from '../shared/platforms'
import { selectionQuestionConversation } from '../shared/deepseek-question'
import type { FileReadContext } from '../shared/file-requests'
import { prepareFiles } from './file-access'
import { homedir } from 'node:os'
import type { ChatPlatform } from '../shared/platforms'
import type {
  AppTheme,
  AutomationState,
  Conversation,
  ConversationImageAttachmentInput,
  EmbedBounds,
  EmbedCommand,
  EnvironmentInfo,
  ExecutionMode,
  InterceptorStatus,
  ManagedSessionSummary,
  MysqlConnectionDraft,
  MysqlConnectionsState,
  MysqlDatabaseList,
  MysqlTableData,
  MysqlRowKey,
  MysqlRowDeleteResult,
  MysqlCellUpdateResult,
  MysqlSqlExecutionResult,
  MysqlTableDdl,
  MysqlDdlExportResult,
  MysqlTableList,
  MysqlSaveResult,
  RedisConnectionDraft,
  RedisConnectionResult,
  RedisConnectionsState,
  RedisSaveResult,
  RedisKeyPage,
  RedisKeyData,
  NacosConnectionDraft,
  NacosConnectionsState,
  NacosSaveResult,
  ParsedAction,
  SshHost,
  SshHostDraft,
  SshState,
  TerminalNotes,
  TerminalNotesOwner,
  TerminalState
} from '../shared/types'
import { CommandRunner } from './commands'
import { ExtraTerminals } from './extra-terminals'
import { BackgroundTasks } from './background-tasks'
import { backgroundLaunchPlan, startManagedBackground } from './background-launch'
import { BackgroundTaskResults } from './background-task-results'
import type { BackgroundTaskTarget } from './background-tasks'
import { parseStoredBackgroundTask } from '../shared/background-tasks'
import type { BackgroundTaskTargetDescriptor, StoredBackgroundTask } from '../shared/background-tasks'
import type { ExtraTerminalTarget } from './extra-terminals'
import { ConversationStore } from './db'
import { normalizeNacosUrl } from './nacos-view'
import { readMysqlColumnMetadata, mysqlColumnDescriptions, mysqlRowKey, mysqlRowDeleteUnavailable, mysqlColumnsEditable, deleteMysqlRowWithConnection, updateMysqlCellWithConnection } from './mysql-table-rows'
import { readMysqlDatabaseDdl } from './mysql-ddl-export'
import { RedisReader, normalizeRedisDraft } from './redis-reader'
import { ChatGptEmbed } from './embed'
import { FocusChat } from './focus-chat'
import { stageFocusAttachments } from './focus-attachments'
import { cleanFocusUserText, supportsFocusView, validFocusFiles } from '../shared/focus-chat'
import { writeFocusDiagnostic } from './focus-chat-log'
import { getGithubCliState } from './github-cli'
import { dispatchGithubLoginTask } from './github-login-task'
import type { GithubLoginTaskResult } from '../shared/github'
import type { FocusChatState, FocusOwner, FocusSelectionRequest, FocusSendRequest, FocusEditRequest, FocusSendOutcome } from '../shared/focus-chat'
import type { EmbedHandlers } from './embed'
import { nodeFallback, parseLocalPosixEnvironment, parseRemoteEnvironment, parseWindowsEnvironment } from './environment'
import { ConversationShell, resolvePowerShell } from './shell'
import type { ExecutionShell } from './shell'
import { SshManager } from './ssh'
import type { RemoteShell } from './remote-shell'
import { Web2termShell } from './web2term-shell'
import type { Web2termSessionBinding } from './web2term-shell'
import type { Web2termConnection } from './web2term-connection'
import { normalizeTerminalNotesDirectory } from './terminal-notes'

const SETTING_EXECUTION_MODE = 'executionMode'
const SETTING_LOCAL_NOTES = 'localTerminalNotes'

/**
 * Whether a URL is worth storing as a session's location.
 *
 * A DENYLIST rather than an allowlist: sites add routes constantly, and an allowlist would make a
 * session with a novel-but-valid URL silently reopen at the home page. The cost of getting a
 * denylist wrong is only that a dead end opens somewhere useless — which is what it was doing
 * anyway.
 *
 * Two families are excluded, both redirects that a restart must never re-enter:
 *
 *   - **Auth dead ends.** `reauth=1` is an explicit "log out and start over" request, so loading
 *     it puts the app back into the auth flow — and Cloudflare re-challenges the protected auth
 *     host — every single launch. Measured on claude.ai: the session row held exactly such a URL
 *     and could never get past the challenge, while the same challenge cleared in ~24s when the
 *     page was entered at its normal URL.
 *   - **Bot-check interstitials.** `__cf_chl_` links are single-use and expire in minutes; a URL
 *     holding one is guaranteed to be stale by the next start.
 */
function isRestorableUrl(raw: string): boolean {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return false
  }
  if (/[?&]reauth=/.test(url.search)) return false
  if (url.searchParams.has('__cf_chl_tk') || url.searchParams.has('__cf_chl_rt_tk')) return false
  /*
   * `log-?in` / `log-?out` rather than the bare words, because the hyphenated spellings are
   * exactly the ones in use: OpenAI's sign-in page is `auth.openai.com/log-in`, and a first
   * version of this test asserted on it and failed. Cheap to cover both; the alternative is
   * discovering the hyphen one host at a time.
   */
  if (/^\/(log-?in|log-?out|sign-?in|sign-?up|register|auth)(\/|$)/i.test(url.pathname)) return false
  return true
}

/**
 * One platform's embedded view plus the state that must survive being hidden.
 *
 * `conversationId` and `url` are per-platform because each site has its own notion of "where
 * this session is" â€” the same session id means a ChatGPT `/c/<uuid>` and a DeepSeek
 * `/a/chat/s/<uuid>`, and neither is meaningful on the other site. Keeping one pair for the
 * session would make the two views overwrite each other's location on every switch.
 */
interface PlatformEmbed {
  readonly platform: ChatPlatform
  /** Created on first use; see `ensureEmbed`. */
  embed: ChatGptEmbed | null
  conversationId: string | null
  url: string
}

export const EMPTY_SSH_STATE: SshState = {
  status: 'disconnected',
  attached: false,
  name: '',
  target: '',
  hostId: '',
  message: '',
  remoteExec: false,
  modelCwd: '',
  ptyCwd: '',
  lines: []
}

export interface SessionRuntimeOptions {
  web2term?: { binding: Web2termSessionBinding; connection: Web2termConnection }
  /**
   * Which chat site this session starts on.
   *
   * Required. A default would let a DeepSeek session inherit ChatGPT's partition and URL
   * patterns, which fails as "signed into the wrong account" rather than as an error.
   *
   * This is the STARTING site, not a permanent property: the user can switch platforms from
   * inside the chat and both views stay alive. See `embeds`.
   */
  platform: ChatPlatform
  id?: string
  createdAt?: number
  customTitle?: string
  projectId?: string | null
  initialUrl?: string
  initialConversationId?: string | null
  initialPaused?: boolean
  initialPromptInjectionEnabled?: boolean
  initialLocalCwd?: string
  initialSshHostId?: string
  initialSshAttached?: boolean
  initialSshReconnect?: boolean
  initialSshCwd?: string
  initialSendDelaySeconds?: number
  store: ConversationStore
  localMachineId: string
  initialMode: ExecutionMode
  /**
   * Only `sshProxy` and `theme` are read from here. The embed proxies are applied by
   * `index.ts` directly, per platform, and the theme is pushed to every view as it changes —
   * this callback is what a view created LATER reads, so it does not have to be told twice.
   * `embedProxy` is typed as the map it now is rather than omitting it, so this dependency
   * keeps mirroring `AppSettings` instead of becoming its own narrower shape that silently
   * drifts.
   */
  settings: () => { embedProxy: Record<string, string>; sshProxy: string; theme: AppTheme }
  onSummaryChanged: () => void
  onTransfersChanged: () => void
  onTerminalNotesSaved: (owner: TerminalNotesOwner) => void
  onPendingQuestionsChanged: (id: string, platformId: string, count: number) => void
  onTaskCompleted: (id: string) => void
  onActivate: (id: string) => void
  /**
   * The ACTIVE platform's view loaded its page for the first time.
   *
   * Startup uses this to close the splash window: the splash must not go away on a
   * timer, because a cold page on a slow network takes seconds and the user would
   * then stare at a blank workspace instead of the animation. Background platforms
   * deliberately do not report here - nobody is waiting on a page they cannot see.
   */
  onEmbedReady?: () => void
}

function encryptSecret(password: string): string {
  if (password === '') return ''
  try {
    if (!safeStorage.isEncryptionAvailable()) return ''
    return safeStorage.encryptString(password).toString('base64')
  } catch {
    return ''
  }
}

function decryptSecret(secret: string): string {
  if (secret === '') return ''
  try {
    if (!safeStorage.isEncryptionAvailable()) return ''
    return safeStorage.decryptString(Buffer.from(secret, 'base64'))
  } catch {
    return ''
  }
}

/**
 * Turn a mysql2 failure into one line a user can act on.
 *
 * mysql2 errors carry a `code` for the common causes (bad password, host unreachable,
 * unknown host) and a message that is already specific; the code is what makes the
 * difference between "it failed" and "the password is wrong". Anything without a code
 * falls back to the message, so an unexpected failure is still readable rather than blank.
 */
function mysqlErrorMessage(error: unknown): string {
  const record = error as { code?: unknown; message?: unknown }
  const message = typeof record?.message === 'string' ? record.message.trim() : ''
  switch (record?.code) {
    case 'ER_ACCESS_DENIED_ERROR':
      return `用户名或密码不正确。${message}`
    case 'ER_DBACCESS_DENIED_ERROR':
      return `当前用户没有查看数据库的权限。${message}`
    case 'ECONNREFUSED':
      return `无法连接：目标端口拒绝连接，请确认 MySQL 已启动并允许远程访问。${message}`
    case 'ETIMEDOUT':
    case 'PROTOCOL_SEQUENCE_TIMEOUT':
      return `连接超时：请确认主机地址、端口和防火墙设置。${message}`
    case 'ENOTFOUND':
      return `找不到主机：请检查主机地址是否正确。${message}`
    case 'ER_NOT_SUPPORTED_AUTH_MODE':
      return `服务器要求的认证方式不受支持。${message}`
    default:
      return message === '' ? '连接失败，请检查连接信息。' : message
  }
}
function normalizeProxy(raw: string): string {
  const trimmed = raw.trim()
  if (trimmed === '') return ''
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`
}

export class SessionRuntime {
  private readonly redisReader = new RedisReader()
  readonly id: string
  readonly createdAt: number
  readonly runner: CommandRunner
  readonly ssh: SshManager
  readonly backgroundTasks = new BackgroundTasks(state => this.send(IpcChannels.backgroundTasksChanged, state),
    stored => this.persistBackgroundTask(stored))
  private readonly backgroundTaskResults = new BackgroundTaskResults({
    canSend: owner => {
      if (this.disposed || this.activePlatformId !== owner.platformId || !this.runner.canSendAutomaticResult()) return false
      const embed = this.embeds.get(owner.platformId)?.embed
      return Boolean(embed && embed.getState().conversationId === owner.conversationId
        && embed.getInterceptorStatus().enabled && !embed.getInterceptorStatus().pendingQuestion)
    },
    send: (text, owner) => this.embeds.get(owner.platformId)!.embed!.sendRaw(text, { conversationId: owner.conversationId, requireIdle: true }),
    onStatus: (id, status, message, kind) => this.backgroundTasks.setDelivery(id, status, message, kind)
  })
  /** User-opened terminals beside the model's; each takes the transport and directory it has right now. */
  readonly extraTerminals = new ExtraTerminals({
    target: () => this.extraTerminalTarget(),
    openSsh: (hostId, cwd, handlers) => {
      const state = this.ssh.getState()
      if (state.hostId !== hostId || state.status !== 'connected') {
        return Promise.reject(new Error('这个终端所属的 SSH 主机已断开或已切换，请关闭后重新新建。'))
      }
      return this.ssh.openExtraShell(cwd, handlers)
    },
    onChanged: (state) => this.send(IpcChannels.extraTerminalsChanged, state)
  })

  window: BrowserWindow | null = null
  environment: EnvironmentInfo = nodeFallback()
  environmentScope: Pick<TerminalNotes, 'scope' | 'hostId' | 'label'> = {
    scope: 'local',
    hostId: '',
    label: '本机'
  }

  /**
   * One embedded view per chat platform, ALL kept alive.
   *
   * WHY NOT ONE VIEW THAT GETS REPLACED
   * -----------------------------------
   * The obvious design is to rebuild the session when the user switches models. That would
   * call `dispose()`, which tears down `ssh` and the terminal â€” so switching models would
   * silently drop a live SSH connection, clear the terminal scrollback, and lose the
   * conversation on both sides. `SessionRuntime` owns the machine (terminal, SSH, environment
   * probe) as well as the chat, so the chat is the part that must be swappable in place.
   *
   * Keeping both views alive costs one extra WebContents and makes switching a visibility
   * change: each platform keeps its own conversation, its own scroll position, and its own
   * in-flight reply. The same reasoning as "one terminal, not one per conversation" â€” the
   * expensive shared thing (the machine) does not move when only the model changes.
   */
  private readonly embeds = new Map<string, PlatformEmbed>()
  private activePlatformId: string
  private preferredSendDelaySeconds: number
  private promptInjectionEnabled: boolean
  private remoteShell: RemoteShell | null = null
  private sshTerminalResetting = false
  readonly web2term: Web2termShell | null
  private customTitle: string
  private projectId: string | null
  private sshCwd: string
  private lastPersistedLocalCwd: string
  private lastDirectoryNotes: TerminalNotes | null = null
  private disposed = false
  private active = false
  private lastSummaryTaskRunning = false
  private embedVisible = true
  /**
   * Last rectangle the renderer reported for the slot.
   *
   * Kept because a platform view can be created AFTER the renderer last measured: the
   * `ResizeObserver` only fires on a resize, so nothing would tell the new view where the slot
   * is and it would appear at its default size. Applying the remembered rectangle at creation
   * keeps that from depending on a second renderer round-trip.
   */
  private lastBounds: EmbedBounds | null = null
  private readonly deferredCommands = new Map<string, ParsedAction>()
  /** Keep async execution diagnostics with their source platform after the user switches views. */
  private readonly commandDiagnosticPlatforms = new Map<string, ChatPlatform>()
  /**
   * The last thing the user asked for, held until the conversation has an id.
   *
   * The first message of a new chat is sent while the SPA is still at `/`; the `/c/<id>`
   * URL appears only AFTER the send. So the goal is captured on send and associated
   * here, and `onConversation` flushes it â€” the same ordering problem
   * `deferredCommands` exists for.
   */
  private pendingGoal = ''
  private readonly focusChat: FocusChat
  private focusSending = false
  private focusUiRecovering = false
  private focusUiRecoveredTurn: { platformId: string; conversationId: string; turnId: string } | null = null
  private focusRevision: { token: string; platformId: string; conversationId: string; turnIds: string[]; messageIds: string[]; acknowledged: boolean } | null = null
  private focusUploadAbort: AbortController | null = null
  /** Clean chat turns waiting for a brand-new conversation to receive its URL/id. */
  private readonly pendingConversationMessages = new Map<
    string,
    Array<{
      role: 'user' | 'assistant'
      text: string
      sourceMessageId: string | null
      attachments: ConversationImageAttachmentInput[]
      focusTurnId?: string
    }>
  >()

  constructor(private readonly options: SessionRuntimeOptions) {
    this.web2term = options.web2term ? new Web2termShell(options.web2term.binding, options.web2term.connection) : null
    if (this.web2term) {
      this.environment = { ...FALLBACK_ENVIRONMENT, kind: 'posix', osCaption: 'Linux', shellPath: '/bin/sh', powerShellExe: '', workingDirectory: '', remoteName: this.web2term.binding.deviceName, remoteTarget: this.web2term.binding.agentId }
      this.environmentScope = { scope: 'ssh', hostId: this.web2term.hostId, label: this.web2term.binding.deviceName || this.web2term.binding.agentId }
    }
    this.id = options.id ?? randomUUID()
    this.focusChat = new FocusChat(this.id, options.store)
    this.createdAt = options.createdAt ?? Date.now()
    this.customTitle = options.customTitle?.trim() ?? ''
    this.projectId = options.projectId ?? null
    this.sshCwd = options.initialSshCwd?.trim() ?? ''
    this.lastPersistedLocalCwd = options.initialLocalCwd?.trim() ?? ''
    this.activePlatformId = options.platform.id
    this.preferredSendDelaySeconds = options.initialSendDelaySeconds ?? 0
    this.promptInjectionEnabled = options.initialPromptInjectionEnabled ?? true

    for (const platform of CHAT_PLATFORMS) {
      /*
       * Every platform gets a slot, but only the one being restored gets a live view. The
       * other is created on first switch (`ensureEmbed`) and stays alive from then on â€” which
       * is what preserves its conversation and scroll position across later switches.
       *
       * Not created up front because a session sitting in the manager would otherwise load two
       * sites nobody is looking at, which also means two sets of background beacons.
       */
      const isStarting = platform.id === options.platform.id
      this.embeds.set(platform.id, {
        platform,
        embed: null,
        conversationId: isStarting ? options.initialConversationId ?? null : null,
        url: isStarting ? options.initialUrl ?? '' : ''
      })
    }
    this.ensureEmbed(options.platform.id)

    this.runner = new CommandRunner({
      store: options.store,
      currentConversationId: () => this.disposed ? null : this.embed.getState().conversationId,
      onCommandDiagnostic: (details) => {
        const owner = details.ownerConversationId
        const platform = (owner && this.commandDiagnosticPlatforms.get(owner)) || this.activePlatform
        if (owner && !this.commandDiagnosticPlatforms.has(owner)) {
          if (this.commandDiagnosticPlatforms.size >= 256) {
            this.commandDiagnosticPlatforms.delete(this.commandDiagnosticPlatforms.keys().next().value!)
          }
          this.commandDiagnosticPlatforms.set(owner, platform)
        }
        this.traceCommand(platform, details)
        if (details.event === 'delivery') {
          this.focusChat.delivery(platform.id, details.ownerConversationId ?? undefined, details.messageId,
            details.deliveryOutcome === 'ok' || details.deliveryOutcome === 'sent' ? 'sent' :
              details.deliveryOutcome === 'busy' ? 'blocked' : details.reason === 'superseded' ? 'superseded' : 'failed')
        }
      },
      sendRawToPage: (text) => this.embed.sendRaw(text),
      fileContext: () => this.fileReadContext(),
      filePlatform: () => this.web2term ? null : fileReadingPlatform(this.activePlatform.id),
      prepareFiles: (request, signal) => prepareFiles(request, signal, (path, limit, abort) => this.ssh.readFileForModel(path, request.context.hostId, limit, abort), fileReadingPlatform(this.activePlatform.id)?.id),
      sendFilesToPage: (result, token, current, signal) => this.embed.sendFileResult(result, token, current, signal),
      terminalModeEnabled: () => !this.disposed && this.embed.getInterceptorStatus().enabled,
      remoteShell: () => this.web2term ?? this.remoteShell,
      terminalTransport: () => this.web2term?.transport,
      onRemoteLine: (line) => { if (!this.web2term) this.ssh.pushModelLine(line) },
      onRemoteOutput: (chunk) => { if (!this.web2term) this.ssh.pushModelOutput(chunk) },
      onExecutionChanged: (records) => this.send(IpcChannels.executionChanged, records),
      captureBackgroundTasks: (record, shell) => {
        const target = this.backgroundTaskTarget(shell)
        const owner = { platformId: this.activePlatformId, conversationId: record.conversationId }
        const ready = (): boolean => this.backgroundTargetCurrent(target)
        const settled = this.backgroundTaskResults.capture(owner, ready)
        const registered = this.backgroundTaskResults.capture(owner, ready, 'created')
        return output => this.backgroundTasks.register(output, record, target, settled, registered, owner)
      },
      startBackgroundTask: async (record, shell, run) => {
        const target = this.backgroundTaskTarget(shell)
        const owner = { platformId: this.activePlatformId, conversationId: record.conversationId }
        const ready = (): boolean => this.backgroundTargetCurrent(target)
        const settled = this.backgroundTaskResults.capture(owner, ready)
        const created = this.backgroundTaskResults.capture(owner, ready, 'created')
        const plan = backgroundLaunchPlan(record.command, record.description, shell.kind, shell.cwd)
        return startManagedBackground(plan, run, registration =>
          this.backgroundTasks.registerTasks([registration], record, target, settled, created, owner, true))
      },
      onTaskStarted: () => this.embed.startTerminalTask(),
      onTerminalChanged: (state) => {
        this.send(IpcChannels.terminalChanged, state)
        this.refreshDirectoryNotes()
        if (state.cwd !== this.lastPersistedLocalCwd) {
          this.lastPersistedLocalCwd = state.cwd
          this.options.onSummaryChanged()
        }
      },
      onTaskCompleted: (description) => {
        void this.embed.endTask()
        this.notifyTaskCompleted(description.trim() || '任务已完成')
      }
    }, options.initialLocalCwd ?? '')

    if (this.web2term) {
      this.web2term.onOutput = chunk => this.runner.pushRemoteOutput(chunk)
      this.web2term.onChanged = message => {
        if (this.disposed) return
        this.runner.refreshTerminal(message)
        this.options.onSummaryChanged()
      }
      this.web2term.onReady = () => { void this.probeEnvironment() }
    }

    this.runner.restoreMode(options.initialMode)
    this.runner.restorePaused(options.initialPaused ?? false)
    this.runner.setSendDelay(options.platform.id === DEEPSEEK_PLATFORM.id ? 4 : this.preferredSendDelaySeconds)
    this.embed.setBaselinePolicy(options.initialMode === 'auto')

    this.ssh = new SshManager((state) => {
      if (this.web2term) return
      this.send(IpcChannels.sshChanged, state)
      if (state.modelCwd !== '') this.sshCwd = state.modelCwd
      this.options.onSummaryChanged()

      const next = this.ssh.execShell()
      const resetting = this.sshTerminalResetting
      // Retain the closed remote backend while reset reconnects, so commands cannot
      // fall through to the local shell between the old and new SSH channels.
      if (resetting && next === null && state.attached) return
      this.sshTerminalResetting = false
      if (next !== this.remoteShell) {
        const previous = this.remoteShell
        this.remoteShell = next
        this.refreshDirectoryNotes()
        if (previous === null || next === null || resetting) void this.probeEnvironment()
      } else if (next === null && state.status === 'error') {
        this.refreshDirectoryNotes()
        void this.probeEnvironment()
      } else {
        this.refreshDirectoryNotes()
      }
    }, (downloads) => {
      this.send(IpcChannels.sshDownloadsChanged, downloads)
      this.options.onTransfersChanged()
    }, (uploads) => {
      this.send(IpcChannels.sshUploadsChanged, uploads)
      this.options.onTransfersChanged()
    })

    this.refreshDirectoryNotes()
    const restoredHostId = options.initialSshHostId?.trim() ?? ''
    if (!this.web2term && options.initialSshAttached && restoredHostId !== '') {
      const host = options.store.listSshHosts().find((item) => item.id === restoredHostId)
      if (host) {
        const target = { hostId: host.id, name: host.name, host: host.host, port: host.port }
        const canReconnect = options.initialSshReconnect && decryptSecret(options.store.getSshSecret(host.id)) !== ''
        if (canReconnect) {
          this.connectSsh(
            {
              id: host.id,
              name: host.name,
              host: host.host,
              port: host.port,
              username: host.username,
              password: '',
              proxy: host.proxy
            },
            this.sshCwd
          )
        } else {
          this.ssh.restoreAttachment(target)
        }
      }
    }
    this.restoreBackgroundTasks()
  }

  /** Save one task; `active` rows (running, or a notification still owed) are never pruned. */
  private persistBackgroundTask(stored: StoredBackgroundTask): void {
    const active = !stored.settled || stored.task.deliveryStatus === 'pending' || stored.task.creationDeliveryStatus === 'pending'
    this.options.store.saveBackgroundTask(this.id, stored.task.id, stored.task.createdAt, JSON.stringify(stored), active)
  }

  /**
   * Tasks saved before a restart: running ones are observed again, and a notification that
   * had not reached the AI is queued once more for its original conversation. A task that
   * settles from here on sends its result as usual.
   */
  private restoreBackgroundTasks(): void {
    let items: StoredBackgroundTask[] = []
    try { items = this.options.store.listBackgroundTaskPayloads(this.id).flatMap(raw => parseStoredBackgroundTask(raw) ?? []) }
    catch (error) { console.warn('[background] restore failed:', error instanceof Error ? error.name : 'Error') }
    if (!items.length) return
    const targets = new Map<string, BackgroundTaskTarget>()
    const targetFor = (stored: StoredBackgroundTask): BackgroundTaskTarget => {
      let target = targets.get(stored.task.id)
      if (!target) { target = this.backgroundTargetFrom(stored.target); targets.set(stored.task.id, target) }
      return target
    }
    this.backgroundTasks.restore(items, descriptor => this.backgroundTargetFrom(descriptor),
      stored => stored.settled ? undefined
        : this.backgroundTaskResults.capture(stored.owner, () => this.backgroundTargetCurrent(targetFor(stored))))
    for (const stored of items) {
      const ready = (): boolean => this.backgroundTargetCurrent(targetFor(stored))
      if (stored.task.creationDeliveryStatus === 'pending') this.backgroundTaskResults.capture(stored.owner, ready, 'created')({ ...stored.task })
      if (stored.settled && stored.task.deliveryStatus === 'pending') this.backgroundTaskResults.capture(stored.owner, ready)({ ...stored.task })
    }
  }

  /**
   * Handlers for ONE platform's view.
   *
   * `platform` is a parameter rather than read from `this`, because the closures are created
   * during construction â€” before `this.activePlatformId` means anything â€” and because a
   * handler that guessed its own platform would attribute a background page's events to
   * whichever view happens to be in front.
   */
  private embedHandlers(platform: ChatPlatform): EmbedHandlers {
    const record = (): PlatformEmbed => this.embeds.get(platform.id) as PlatformEmbed
    /*
     * A FUNCTION, not a captured boolean. The handlers outlive a platform switch and are how
     * the background view reports in, so "am I the visible one" has to be asked at event time
     * â€” capture it and the view in front would keep the old answer forever.
     */
    const isActive = (): boolean => platform.id === this.activePlatformId

    return {
      onQuestionChat: state => {
        if (isActive()) this.send(IpcChannels.questionChatState, state)
      },
      readQuestionContext: conversationId => {
        if (record().conversationId !== conversationId) return null
        const conversation = this.options.store.list().find(item => item.id === conversationId)
        if (!conversation || selectionQuestionConversation(platform.id, conversation.url)?.id !== conversationId) return null
        return { conversationId, title: conversation.title, messages: this.options.store.listConversationMessages(conversationId) }
      },
      onState: (state) => {
        const entry = record()
        /*
         * Remember the URL ONLY when it is one a restart should reopen.
         *
         * This used to store any non-empty URL, and that is how a session got stuck: claude.ai
         * redirected through an involuntary logout to
         * `/login?from=logout&reauth=1&returnTo=%2Fnew%3F`, that URL was written to the session
         * row, and every later start loaded it again. Loading a `reauth=1` URL asks the site to
         * log out and start over — so the app re-entered the auth flow (and its Cloudflare
         * challenge) on every launch instead of entering at the clean URL a probe used, where the
         * same challenge cleared in ~24 seconds.
         *
         * A persisted URL is a promise that reopening it is useful. A redirect dead end is not.
         */
        if (state.url !== '' && isRestorableUrl(state.url)) entry.url = state.url

        /*
         * Only the visible view drives the UI. A background platform keeps its own state
         * (url, conversation id) so switching back lands where it was, but pushing its
         * `embed:state` would overwrite the address bar and status line of the view the
         * user is actually looking at.
         */
        if (isActive()) this.send(IpcChannels.embedState, state)

        if (state.conversationId !== entry.conversationId) {
          const previousConversationId = entry.conversationId
          entry.conversationId = state.conversationId
          if (supportsFocusView(platform.id)) this.focusChat.context(platform.id, state.conversationId)
          const createdNewChat = previousConversationId === null && state.conversationId !== null
          // The first send creates its conversation id; keep that task's injection.
          // A real conversation change starts with an unused prompt in every execution mode.
          if (!createdNewChat) entry.embed?.resetTaskPrompt()
          /*
           * Arming the baseline on a background view would be wasted work, and skipping it
           * is safe: showing a platform again re-arms through `switchPlatform`.
           */
          if (!createdNewChat && isActive() && this.runner?.getAutomation().mode === 'auto') {
            // `entry.embed` exists whenever a handler can fire: the handlers are passed to the
            // embed's own constructor, so this event came from it.
            void entry.embed?.armCommandBaseline()
          }
        }
        this.options.onSummaryChanged()
      },
      onReady: () => {
        /*
         * Same rule as the state push above: only the visible view decides that startup
         * is over. A background platform finishing its load says nothing about the page
         * the user is looking at.
         */
        if (isActive()) this.options.onEmbedReady?.()
      },
      onConversation: (conversation) => {
        this.options.store.upsert(conversation, this.currentConversationProject())
        this.flushDeferredCommands(conversation.id)
        this.flushPendingGoal(conversation.id)
        this.flushPendingConversationMessages(platform.id, conversation.id)
        this.focusChat.flush(platform.id)
        this.broadcastConversations()
      },
      onSynced: (scraped) => {
        this.options.store.upsertMany(scraped)
        this.broadcastConversations()
      },
      onUserStarted: (text, files, editToken) => {
        const revision = this.focusRevision
        if (editToken && (!revision || revision.acknowledged || revision.token !== editToken || revision.platformId !== platform.id ||
          revision.conversationId !== record().conversationId)) return undefined
        if (editToken && revision) {
          this.deferredCommands.clear()
          this.backgroundTaskResults.cancel({ platformId: platform.id, conversationId: revision.conversationId })
        }
        const turnId = editToken && revision
          ? this.focusChat.revise(platform.id, revision.conversationId, text, revision.turnIds, revision.messageIds)
          : this.focusChat.begin(platform.id, record().conversationId, text, files)
        if (editToken && revision) revision.acknowledged = true
        if (supportsFocusView(platform.id)) writeFocusDiagnostic({ sessionId: this.id, platformId: platform.id, conversationId: record().conversationId },
          { event: 'user-started', turnId, inputLength: text.length, attachmentCount: files?.length ?? 0 })
        return turnId
      },
      onUserMessage: (text, attachments, turnId, imageSource) => {
        const discarded = !!turnId && !this.focusChat.ownsTurn(platform.id, turnId)
        if (supportsFocusView(platform.id)) writeFocusDiagnostic({ sessionId: this.id, platformId: platform.id, conversationId: record().conversationId },
          { event: discarded ? 'user-discarded' : 'user-captured', turnId, imageSource, inputLength: text.length, attachmentCount: attachments.length })
        if (discarded) return
        this.captureConversationMessage(platform.id, 'user', text, null, attachments, turnId)
      },
      onRawSent: () => this.focusChat.rawSent(platform.id),
      onAssistantMessage: (messageId, text) => {
        this.captureConversationMessage(platform.id, 'assistant', text, messageId)
        this.focusChat.settled(platform.id, messageId, text)
      },
      onAssistantHistoryMarkdown: (messageId, text) => {
        const conversationId = record().conversationId
        if (conversationId) this.options.store.refreshAssistantMessageMarkdown(conversationId, messageId, text)
        // The focus view keeps its own copy of each answer; refresh that one too.
        if (conversationId && supportsFocusView(platform.id)) this.focusChat.refreshAnswer(platform.id, conversationId, messageId, text)
      },
      onInterceptor: (status) => {
        this.captureGoal(status.lastSentText)
        if (!this.disposed) this.options.onPendingQuestionsChanged(this.id, platform.id, status.pendingQuestion?.questions.length ?? 0)
        const taskRunning = status.taskStartedAt !== null && status.taskFinishedAt === null
        if (isActive() && taskRunning !== this.lastSummaryTaskRunning) {
          this.lastSummaryTaskRunning = taskRunning
          this.options.onSummaryChanged()
        }
        if (isActive()) this.send(IpcChannels.interceptorEvent, status)
      },
      onQuestion: (question, count) => {
        if (isActive()) this.notifyQuestion(question, count)
      },
      onQuestionRecorded: (messageId, rawJson) => {
        const conversationId = record().conversationId
        if (!conversationId) return
        try {
          this.options.store.saveRecentCommandJson(conversationId, messageId, rawJson)
        } catch (error) {
          console.warn('[cmd] question not recorded:', (error as Error).message)
        }
      },
      onTaskCompleted: () => {
        if (isActive()) this.notifyTaskCompleted('任务已完成')
      },
      /*
       * ONLY the visible platform feeds the command loop.
       *
       * Not an optimisation â€” two live views with automation on would mean two sources of
       * "the model asked for this", and `executions.message_id` is the idempotency key that
       * makes a command run once. A hidden DeepSeek tab replaying its history into the same
       * terminal as the ChatGPT tab in front would be untraceable. Commands are recorded
       * under the conversation they were read from, so the visible one is the only correct
       * answer to "which conversation is this session driving".
       */
      onCommand: (command) => {
        this.traceCommand(platform, {
          event: 'received', messageId: command.messageId, active: isActive(), live: command.live,
          commandLength: 'command' in command ? command.command.length : undefined
        })
        /*
         * Logged on BOTH sides of the gate.
         *
         * "The page reported a command" and "the app acted on one" are different facts, and
         * `isActive()` is what sits between them: with another platform in front, a command read
         * from a background view is dropped here â€” deliberately, and until now invisibly. That is
         * the combination that makes "the model answered with JSON and nothing ran" impossible to
         * diagnose from a log, which is exactly how this was found.
         */
        if (!isActive()) {
          this.traceCommand(platform, { event: 'skipped', reason: 'inactive-platform', messageId: command.messageId })
          console.warn(
            `[session] command DROPPED, this session is not the visible one ${JSON.stringify({
              messageId: command.messageId,
              command: 'command' in command ? command.command : command.files.map((file) => file.path)
            })}`
          )
          return
        }
        console.info(
          `[session] command accepted ${JSON.stringify({
            messageId: command.messageId,
            description: command.description
          })}`
        )
        this.handleDetectedCommand(command)
        this.focusChat.command(platform.id, command.messageId, command.live)
      },
      onParseFailed: (payload) => {
        if (!isActive()) return
        if (payload.live !== false) this.focusChat.parseFailed(platform.id, payload)
        this.runner.noteParseFailure(payload.text ?? '')
        if (payload.live === true) void record().embed?.recoverCommand(this.active && this.runner.canSendAutomaticResult())
      },
      onCommandRecovery: recovery => {
        if (isActive()) this.focusChat.commandRecovery(platform.id, recovery)
      }
    }
  }

  private activeEmbed(): PlatformEmbed {
    const entry = this.embeds.get(this.activePlatformId)
    if (entry) return entry
    // Unreachable unless a platform id was persisted that no longer exists; fall back rather
    // than throw, because a stored row must never be able to make a session unopenable.
    const fallback = [...this.embeds.values()][0]
    this.activePlatformId = fallback.platform.id
    return fallback
  }

  /**
   * Create one platform's view if it does not exist yet, and keep it from then on.
   *
   * Idempotent, because it is called from every path that needs the view to exist (construction,
   * attach, switch) and a second call must never create a second page for one platform â€” that
   * would put two views on the same partition and make `getState()` ambiguous.
   */
  private ensureEmbed(platformId: string): PlatformEmbed {
    const entry = this.embeds.get(platformId) as PlatformEmbed
    if (entry.embed) return entry

    entry.embed = new ChatGptEmbed(
      entry.platform,
      this.embedHandlers(entry.platform),
      entry.url || entry.platform.homeUrl
    )
    entry.embed.setPromptInjectionEnabled(this.promptInjectionEnabled)
    if (this.window && !this.window.isDestroyed()) {
      entry.embed.attach(this.window)
      entry.embed.setVisible(false)
    }
    // The renderer measured the slot long before this view existed; see `lastBounds`.
    if (this.lastBounds) entry.embed.setBounds(this.lastBounds)
    entry.embed.setBaselinePolicy(this.runner?.getAutomation().mode === 'auto')
    /*
     * A NEW EMBED STARTS WITH THE FALLBACK PROMPT, so the runtime's real one has to be pushed
     * into it here.
     *
     * `ChatGptEmbed` holds the prefix per view, and every other call site pushes it to the
     * ACTIVE view (`this.embed.setPromptParts(...)`). A view created later therefore keeps the
     * generic fallback â€” which does not describe this machine â€” and switching to it would
     * inject the wrong prompt, or (when the fallback is identical to what the page already has)
     * look like nothing was injected at all.
     */
    entry.embed.setPromptParts(buildTerminalPromptParts(this.environment, this.toolPrompt(entry.platform.id)))
    /*
     * Same reasoning as the prompt above, one line down: the theme lives per VIEW, so a view
     * created after the last theme change would otherwise come up wearing the old one — and
     * the only way to notice would be to switch platform and look.
     */
    entry.embed.setTheme(this.options.settings().theme)
    return entry
  }

  /** The view the user is looking at. Kept for the many call sites that mean "the chat". */
  get embed(): ChatGptEmbed {
    const entry = this.activeEmbed()
    return entry.embed ?? this.ensureEmbed(entry.platform.id).embed!
  }

  attach(parent: BrowserWindow): void {
    if (this.window === parent && !parent.isDestroyed()) return
    this.window = parent
    /*
     * Only the view already in use is attached here. The other platform's view is created when
     * it is first switched to (`ensureEmbed` attaches it then), so a session that is never
     * switched loads exactly one site â€” attaching every platform here would put both sites on
     * the wire for every session the app restores.
     */
    this.ensureEmbed(this.activePlatformId)
    this.embed.attach(parent)
    this.embed.setVisible(false)
    this.options.onSummaryChanged()
    if (!this.web2term && this.ssh.getState().status !== 'connecting') void this.probeEnvironment()
  }

  setActive(active: boolean): void {
    this.active = active
    this.applyVisibility()
  }

  /**
   * Push an app-theme change into every view of this session.
   *
   * Every view, not just the visible one: the hidden platform's page is still rendered, and a
   * view whose theme was never updated is a page that comes up in the wrong colours the next
   * time it is switched to. Views that do not exist yet are covered by `ensureEmbed`, which
   * reads the theme from settings.
   */
  setTheme(theme: AppTheme): void {
    for (const entry of this.embeds.values()) entry.embed?.setTheme(theme)
  }

  /**
   * Show one platform's view and hide the other.
   *
   * Only the visible view is driveable, so this is also where the command baseline is re-armed:
   * the newly shown page has replies on screen that were written long ago, and without a fresh
   * baseline the next check would treat the last one as a live command and execute it.
   *
   * Refused while a task is running, and that guard is HERE rather than only on the button:
   * switching mid-task would hide the page whose reply the loop is waiting on, and the command
   * it eventually produces would be attributed to a conversation that is no longer in front.
   */
  switchPlatform(platformId: string): boolean {
    const entry = this.embeds.get(platformId)
    if (!entry || platformId === this.activePlatformId) return false
    if (this.taskRunning()) return false
    this.activePlatformId = platformId
    this.runner.setSendDelay(platformId === DEEPSEEK_PLATFORM.id ? 4 : this.preferredSendDelaySeconds)
    // Created here on first switch, and kept alive after that so its conversation survives.
    const created = this.ensureEmbed(platformId)
    const embed = created.embed as ChatGptEmbed
    /*
     * Re-pushed on every switch, not just at creation: this view may have been created before
     * the last environment probe or SSH handover, in which case its copy of the prompt is stale
     * and the page would inject a description of the wrong machine.
     */
    const prompts = buildTerminalPromptParts(this.environment, this.toolPrompt(entry.platform.id))
    embed.setPromptParts(prompts)
    this.applyVisibility()
    void embed.armCommandBaseline()
    /*
     * One line naming the platform, the prompt length, and whether the environment behind it is
     * the real probe result or the generic fallback.
     *
     * The prompt is stored per view, so "this view has the wrong prompt" has no symptom other
     * than messages going out un-prefixed â€” which looks exactly like terminal mode being off.
     * `detected` is what separates a probed machine from `FALLBACK_ENVIRONMENT`; the length
     * alone does not, because the two can coincide.
     */
    const prefix = prompts.prefix
    console.info(
      `[session] ${this.id.slice(0, 8)} switched to ${entry.platform.label} ` +
        `(prompt=${prefix.length} detected=${this.environment.detected} ` +
        `os=${JSON.stringify(this.environment.osCaption)})`
    )
    /*
     * Push the new view's state immediately instead of waiting for its next event: a page that
     * is already loaded and idle emits nothing, so the address bar and the interceptor panel
     * would keep describing the platform that is no longer on screen.
     */
    this.send(IpcChannels.embedState, embed.getState())
    this.send(IpcChannels.interceptorEvent, embed.getInterceptorStatus())
    this.send(IpcChannels.questionChatState, embed.getQuestionChatState())
    this.options.onSummaryChanged()
    return true
  }

  /** Which platform this session is currently showing. */
  get activePlatform(): ChatPlatform {
    return this.activeEmbed().platform
  }

  private applyVisibility(): void {
    for (const entry of this.embeds.values()) {
      // A platform that was never switched to has no view yet, and must not get one merely
      // because visibility was recalculated.
      if (!entry.embed) continue
      const visible = this.active && this.embedVisible && entry.platform.id === this.activePlatformId
      entry.embed.setVisible(visible)
    }
  }

  focus(): boolean {
    const window = this.window
    if (!window || window.isDestroyed()) return false
    this.options.onActivate(this.id)
    if (window.isMinimized()) window.restore()
    if (!window.isVisible()) window.show()
    window.focus()
    return true
  }

  setTitle(title: string): void {
    this.customTitle = title.trim()
    this.options.onSummaryChanged()
  }

  setProjectId(projectId: string | null): void {
    this.projectId = projectId
    this.refreshDirectoryNotes()
    this.options.onSummaryChanged()
  }

  persistentState(): {
    id: string
    projectId: string | null
    title: string
    url: string
    conversationId: string | null
    platformId: string
    paused: boolean
    promptInjectionEnabled: boolean
    localCwd: string
    sshHostId: string
    sshAttached: boolean
    sshReconnect: boolean
    sshCwd: string
    sendDelaySeconds: number
    createdAt: number
  } {
    const automation = this.runner.getAutomation()
    const terminal = this.runner.getTerminalState()
    const sshState = this.ssh.getState()
    const active = this.activeEmbed()
    return {
      id: this.id,
      projectId: this.projectId,
      title: this.customTitle,
      /*
       * The persisted url/conversationId/platformId are the ACTIVE platform's. One session
       * stores one location, so restoring must reopen the view the user last had in front â€”
       * storing the starting platform instead would reopen ChatGPT every time even if the
       * user had switched to DeepSeek and left it there.
       */
      url: active.url,
      conversationId: active.conversationId,
      platformId: active.platform.id,
      paused: automation.paused,
      promptInjectionEnabled: this.promptInjectionEnabled,
      localCwd: this.web2term ? '' : terminal.cwd,
      sshHostId: sshState.hostId,
      sshAttached: sshState.attached,
      sshReconnect: sshState.attached && sshState.status !== 'disconnected',
      sshCwd: this.sshCwd,
      sendDelaySeconds: this.preferredSendDelaySeconds,
      createdAt: this.createdAt
    }
  }
  /**
   * Which chat site this session is currently showing.
   *
   * The ACTIVE one, not the starting one: the session-import and auth-state paths use this to
   * decide which site's cookies and login page they are talking about, and after a switch the
   * answer must be the view in front.
   */
  get chatPlatform(): ChatPlatform {
    return this.activeEmbed().platform
  }

  summary(): ManagedSessionSummary {
    const state = this.embed.getState()
    const sshState = this.ssh.getState()
    const usingSsh = sshState.attached
    return {
      id: this.id,
      projectId: this.projectId,
      title: this.customTitle || (state.conversationId ? state.title : '') || (this.web2term ? '远程对话' : usingSsh ? 'SSH 对话' : '本地'),
      kind: this.web2term ? 'web2term' : usingSsh ? 'ssh' : 'local',
      target: this.web2term ? this.web2term.binding.deviceName || this.web2term.binding.agentId : usingSsh ? sshState.name || sshState.target || 'SSH' : '本机',
      conversationId: state.conversationId,
      platformId: this.activeEmbed().platform.id,
      taskRunning: this.taskRunning(),
      createdAt: this.createdAt
    }
  }

  setEmbedBounds(bounds: EmbedBounds): void {
    /*
     * Only the view in front is told the bounds. A hidden platform that was never switched to
     * has no view yet; and once created, `ensureEmbed` gives it the slot rectangle the first
     * time it is shown â€” so a stale rectangle cannot be applied to a view that is not there.
     */
    this.embed.setBounds(bounds)
    this.lastBounds = bounds
  }

  setEmbedVisible(visible: boolean): void {
    /*
     * Remembered rather than applied directly, because "visible" now has two inputs (is this
     * session in front, and is this platform the shown one). Applying `visible` to the active
     * view alone would lose the request when it arrives while the session is in the manager.
     */
    this.embedVisible = visible
    this.applyVisibility()
  }

  setQuestionChatViewport(id: string, bounds: unknown, visible: boolean): void {
    this.embed.setQuestionChatViewport(id, bounds, visible && this.active)
  }

  private taskRunning(): boolean {
    if (this.focusSending) return true
    const status = this.embed.getInterceptorStatus()
    return status.taskStartedAt !== null && status.taskFinishedAt === null
  }

  sendEmbedCommand(command: EmbedCommand): void {
    if (this.taskRunning() && command !== 'stop') return
    this.embed.command(command)
  }

  navigateEmbed(url: string): void {
    if (this.taskRunning()) return
    this.embed.navigate(url)
  }

  private ownsFocus(owner: FocusOwner): boolean {
    return !this.disposed && owner.sessionId === this.id && supportsFocusView(owner.platformId) &&
      this.activePlatformId === owner.platformId && this.embed.getState().conversationId === owner.conversationId
  }

  /** Reconcile one missed native card send from rendered history; never replay its action. */
  private async recoverFocusUi(owner: FocusOwner): Promise<void> {
    if (owner.platformId !== 'chatgpt' || !owner.conversationId || this.focusUiRecovering || this.focusSending || this.focusRevision ||
      this.focusChat.currentTurnId(owner.platformId) || this.runner.hasInFlightWork()) return
    this.focusUiRecovering = true
    let locked = false
    try {
      const messages = this.options.store.listConversationMessages(owner.conversationId)
      const sourceIds = messages.filter(message => message.role === 'assistant' && message.sourceMessageId).map(message => message.sourceMessageId!)
      const recovery = await this.embed.readFocusUiRecovery(sourceIds)
      if (!recovery || !this.ownsFocus(owner) || this.focusSending || this.focusRevision || this.focusChat.currentTurnId(owner.platformId)) return
      const current = this.options.store.listConversationMessages(owner.conversationId)
      const normalized = (text: string): string => cleanFocusUserText(text).replace(/\s+/g, ' ').trim()
      if (current.some(message => message.role === 'user' && (message.sourceMessageId === recovery.userMessageId ||
        normalized(message.content) === normalized(recovery.userText)))) return
      const index = current.findIndex(message => message.role === 'assistant' && message.sourceMessageId === recovery.sourceMessageId)
      if (index < 0) return
      this.focusSending = true; locked = true
      if (!await this.embed.adoptFocusUiRecovery(recovery) || !this.ownsFocus(owner)) return
      const turns = this.focusChat.turns(owner.platformId, owner.conversationId)
      const parent = turns.findIndex(turn => turn.segments.some(segment => segment.sourceMessageId === recovery.sourceMessageId))
      const replaced = parent >= 0 ? turns.slice(parent + 1) : turns.filter(turn => turn.createdAt > current[index].createdAt)
      const turnId = this.focusChat.revise(owner.platformId, owner.conversationId, recovery.userText,
        replaced.map(turn => turn.id), current.slice(index + 1).map(message => message.id))
      if (!turnId) return
      this.captureConversationMessage(owner.platformId, 'user', recovery.userText, recovery.userMessageId, [], turnId)
      this.focusUiRecoveredTurn = { platformId: owner.platformId, conversationId: owner.conversationId, turnId }
      writeFocusDiagnostic(owner, { event: 'smart-ui-recovered', turnId, messageId: recovery.userMessageId, inputLength: recovery.userText.length })
    } catch { /* Recovery is optional; a failed read must not break the focus transcript. */ }
    finally { if (locked) this.focusSending = false; this.focusUiRecovering = false }
  }

  async getFocusChat(owner: FocusOwner): Promise<FocusChatState | null> {
    if (!this.ownsFocus(owner)) return null
    this.focusChat.context(owner.platformId, owner.conversationId)
    await this.recoverFocusUi(owner)
    if (!this.ownsFocus(owner)) return null
    const token = this.focusChat.token(owner.platformId)
    const page = await this.embed.readFocusSnapshot()
    if (!this.ownsFocus(owner)) return null
    if (page) this.focusChat.snapshot(owner.platformId, token, page)
    const recovered = this.focusUiRecoveredTurn
    if (recovered && recovered.platformId === owner.platformId && recovered.conversationId === owner.conversationId &&
      recovered.turnId === this.focusChat.currentTurnId(owner.platformId) && page?.ready && page.generating === 'idle' && page.reply?.sourceMessageId) {
      const turn = this.focusChat.turns(owner.platformId, owner.conversationId).find(item => item.id === recovered.turnId)
      if (turn?.status === 'working') {
        this.focusChat.settled(owner.platformId, page.reply.sourceMessageId, page.reply.answer)
        this.captureConversationMessage(owner.platformId, 'assistant', page.reply.answer, page.reply.sourceMessageId)
      }
      this.focusUiRecoveredTurn = null
    }
    writeFocusDiagnostic(owner, { event: 'view-state', ready: page?.ready === true,
      sendFailed: !!page?.sendFailure, retryable: page?.sendFailure?.retryable === true,
      nativeDraft: page?.nativeDraft === true, waiting: page?.waiting === true, generating: page?.generating ?? 'unknown',
      turnCount: this.focusChat.turns(owner.platformId, owner.conversationId).length,
      answerLength: page?.reply?.answer.length ?? 0,
      reasoningCount: page?.reply?.parts.filter(part => part.kind === 'reasoning').length ?? 0,
      searchCount: page?.reply?.parts.filter(part => part.kind === 'search').length ?? 0 })
    const archivedExecutions = this.focusChat.supersededExecutionIds(owner.platformId, owner.conversationId)
    return { ...owner, ready: page?.ready === true, nativeDraft: page?.nativeDraft === true,
      sendFailure: page?.sendFailure ?? null,
      generating: page?.generating ?? 'unknown', waiting: page?.waiting === true,
      turns: this.focusChat.turns(owner.platformId, owner.conversationId),
      hiddenMessageIds: this.focusChat.hiddenMessageIds(owner.platformId, owner.conversationId),
      smartReplies: page?.smartReplies ?? [],
      composerModes: page?.composerModes ?? [],
      modelSettings: page?.modelSettings,
      executions: owner.conversationId ? this.options.store.listExecutions(owner.conversationId).filter(record => !archivedExecutions.has(record.messageId)) : [] }
  }

  /** @returns '' once the side chat is open, otherwise the message the focus view shows. */
  async askFocusSelection(request: FocusSelectionRequest): Promise<string> {
    if (!this.ownsFocus(request) || !request.conversationId) return '当前会话已切换，请重新选择文字。'
    const { selectedText, question, answerText, sourceMessageId } = request
    if (typeof selectedText !== 'string' || typeof question !== 'string' || typeof answerText !== 'string' ||
        !selectedText.trim() || !question.trim() || selectedText.length > 20000 || question.length > 20000 || answerText.length > 500000 ||
        (sourceMessageId !== undefined && (typeof sourceMessageId !== 'string' || sourceMessageId.length > 512))) {
      return '选区已失效，请重新选中文字并输入问题。'
    }
    return this.embed.askSelectionFromFocus({ selectedText, question: question.trim(), answerText, sourceMessageId })
  }

  async requestGithubLogin(owner: FocusOwner): Promise<GithubLoginTaskResult> {
    if (this.focusSending) return { status: 'blocked', message: '当前正在发送消息，请稍后重试。' }
    this.focusSending = true
    const controller = new AbortController()
    this.focusUploadAbort = controller
    try {
      return await dispatchGithubLoginTask({
        blockedReason: () => {
          if (controller.signal.aborted) return '登录任务发送已取消。'
          if (this.disposed || !this.active || owner.sessionId !== this.id || owner.platformId !== this.activePlatformId ||
            owner.conversationId !== this.embed.getState().conversationId) return '当前会话已切换，请在当前 AI 对话中重新操作。'
          if (this.web2term || this.ssh.getState().attached) return 'GitHub 仓库管理使用本机账号，请先将当前终端切回本机。'
          const status = this.embed.getInterceptorStatus()
          if (!status.installed || !status.enabled || !status.promptInjectionEnabled) return '请先启用当前对话的终端模式和提示词注入，再让 AI 协助登录。'
          if (status.taskStartedAt !== null && status.taskFinishedAt === null) return '当前 AI 正在处理任务，请结束后再试。'
          return null
        },
        inspect: getGithubCliState,
        send: text => this.embed.sendUserTask(text)
      })
    } finally {
      if (this.focusUploadAbort === controller) this.focusUploadAbort = null
      this.focusSending = false
    }
  }

  /** Retry the rejected native message; never run its associated shell command again. */
  async retryFocusSend(owner: FocusOwner, failureId: string): Promise<FocusSendOutcome> {
    if (!this.ownsFocus(owner)) return 'unavailable'
    if (this.focusSending || this.runner.hasInFlightWork()) return 'busy'
    this.focusSending = true
    writeFocusDiagnostic(owner, { event: 'send-retry-request' })
    try {
      const outcome = await this.embed.retryFocusSend(failureId, () => this.ownsFocus(owner))
      writeFocusDiagnostic(owner, { event: 'send-retry-outcome', outcome })
      return outcome
    } finally { this.focusSending = false }
  }

  async retryCommandRecovery(owner: FocusOwner, token: number): Promise<string> {
    if (this.disposed || !this.active || owner.sessionId !== this.id || owner.platformId !== this.activePlatformId ||
      owner.conversationId !== this.embed.getState().conversationId || this.embed.getInterceptorStatus().commandRecovery?.token !== token) return 'stale'
    return this.embed.recoverCommand(this.runner.canSendAutomaticResult(), true)
  }

  async sendFocusMessage(request: FocusSendRequest): Promise<FocusSendOutcome> {
    if (!this.ownsFocus(request)) return 'unavailable'
    if (typeof request.text !== 'string' || request.text.length > 20000 ||
      !validFocusFiles(request.files ?? []) || (!request.text.trim() && !request.files?.length)) return 'invalid'
    if (this.focusSending) return 'busy'
    this.focusSending = true
    writeFocusDiagnostic(request, { event: 'send-request', inputLength: request.text.length, attachmentCount: request.files?.length ?? 0 })
    const controller = new AbortController()
    this.focusUploadAbort = controller
    const embed = this.embed
    // The page uploader pins the first created conversation after its single submit.
    // The runtime guard owns the workspace/platform; it must not reject that home -> chat binding.
    const uploadCurrent = (): boolean => !this.disposed && !controller.signal.aborted &&
      this.focusUploadAbort === controller && this.activePlatformId === request.platformId && this.embed === embed &&
      (request.conversationId === null || embed.getState().conversationId === request.conversationId)
    let staged: Awaited<ReturnType<typeof stageFocusAttachments>> | undefined
    try {
      if (request.files?.length) staged = await stageFocusAttachments(request.files)
      const outcome = controller.signal.aborted || !this.ownsFocus(request) ? 'cancelled' : staged
        ? await embed.sendFocusFiles(request.text, staged.attachments, 'focus:' + randomUUID(), uploadCurrent, controller.signal,
          (request.files ?? []).filter(file => file.mimeType.startsWith('image/')).map(file => ({ ...file, width: null, height: null })))
        : await this.embed.sendFocusUser(request.text)
      writeFocusDiagnostic(request, { event: 'send-outcome', outcome })
      return outcome
    }
    catch {
      writeFocusDiagnostic(request, { event: 'send-outcome', outcome: 'upload-failed' })
      return 'upload-failed'
    } finally {
      await staged?.cleanup().catch(() => {})
      if (this.focusUploadAbort === controller) this.focusUploadAbort = null
      this.focusSending = false
    }
  }

  async setFocusComposerMode(request: FocusComposerModeRequest): Promise<FocusSendOutcome> {
    if (!this.ownsFocus(request) || request.platformId !== 'deepseek') return 'unavailable'
    if (!['thinking', 'search'].includes(request.id) || typeof request.active !== 'boolean') return 'invalid'
    if (this.focusSending || this.focusRevision || this.runner.hasInFlightWork() || this.embed.getInterceptorStatus().pendingQuestion) return 'busy'
    this.focusSending = true
    writeFocusDiagnostic(request, { event: 'composer-mode-request', composerMode: request.id, active: request.active })
    try {
      const result = await this.embed.setFocusComposerMode(request.id, request.active)
      const outcome = this.ownsFocus(request) ? result : 'cancelled'
      writeFocusDiagnostic(request, { event: 'composer-mode-outcome', composerMode: request.id, active: request.active, outcome })
      return outcome
    } finally { this.focusSending = false }
  }

  async updateFocusModelSettings(request: FocusModelSettingsRequest): Promise<FocusModelSettingsResult> {
    if (!this.ownsFocus(request) || request.platformId !== 'chatgpt') return { outcome: 'unavailable', settings: null }
    if (!validFocusModelSettingsRequest(request)) return { outcome: 'invalid', settings: null }
    if (this.focusSending || this.focusRevision || this.runner.hasInFlightWork() || this.embed.getInterceptorStatus().pendingQuestion) return { outcome: 'busy', settings: null }
    this.focusSending = true
    writeFocusDiagnostic(request, { event: 'model-setting-request', setting: request.kind })
    try {
      const result = await this.embed.updateFocusModelSettings(request, randomUUID(), () => this.ownsFocus(request) && !this.runner.hasInFlightWork())
      const resolved: FocusModelSettingsResult = this.ownsFocus(request) ? result : { outcome: 'cancelled', settings: null }
      writeFocusDiagnostic(request, { event: 'model-setting-outcome', setting: request.kind, outcome: resolved.outcome, reason: resolved.reason })
      return resolved
    } finally { this.focusSending = false }
  }

  async actOnFocusUi(request: FocusUiRequest): Promise<FocusSendOutcome> {
    if (!this.ownsFocus(request) || request.platformId !== 'chatgpt' || !request.conversationId) return 'unavailable'
    if (!validFocusUiAction(request)) return 'invalid'
    const status = this.embed.getInterceptorStatus()
    writeFocusDiagnostic(request, { event: 'smart-ui-request', action: request.kind,
      taskOpen: status.taskStartedAt !== null && status.taskFinishedAt === null })
    // An open task also covers a settled prose answer asking the user to choose.
    // Let the page check generation/drafts; only actual work owns this main-process lock.
    const busyReason = this.focusSending ? 'send-in-progress' : this.focusRevision ? 'edit-in-progress' :
      this.runner.hasInFlightWork() ? 'command-in-flight' : status.pendingQuestion ? 'question-pending' : null
    if (busyReason) {
      writeFocusDiagnostic(request, { event: 'smart-ui-outcome', action: request.kind, outcome: 'busy', stage: 'prepare', reason: busyReason })
      return 'busy'
    }
    const hidden = new Set(this.focusChat.hiddenMessageIds(request.platformId, request.conversationId))
    const messages = this.options.store.listConversationMessages(request.conversationId).filter(message => !hidden.has(message.id))
    const index = messages.findIndex(message => message.role === 'assistant' && message.sourceMessageId === request.sourceMessageId)
    const turns = this.focusChat.turns(request.platformId, request.conversationId)
    const turnIndex = turns.findIndex(turn => turn.segments.some(segment => segment.sourceMessageId === request.sourceMessageId))
    if (index < 0) {
      writeFocusDiagnostic(request, { event: 'smart-ui-outcome', action: request.kind, outcome: 'unavailable', stage: 'locate', reason: 'component-missing' })
      return 'unavailable'
    }
    const token = randomUUID()
    // A native action on an older card branches from that assistant. Retain its turn,
    // archive only subsequent turns/rows, and commit that change only after a real send.
    const revision = { token, platformId: request.platformId, conversationId: request.conversationId,
      turnIds: (turnIndex >= 0 ? turns.slice(turnIndex + 1) : turns.filter(turn => turn.createdAt > messages[index].createdAt)).map(turn => turn.id),
      messageIds: messages.slice(index + 1).map(message => message.id), acknowledged: false }
    this.focusSending = true
    if (request.kind === 'submit') this.focusRevision = revision
    try {
      const result = await this.embed.actOnFocusUi({ ...request, token }, details => writeFocusDiagnostic(request, { ...details, event: 'smart-ui-page', action: request.kind }))
      const outcome = result === 'ok' && request.kind === 'submit' && !revision.acknowledged ? 'stuck' : result
      writeFocusDiagnostic(request, { event: 'smart-ui-outcome', action: request.kind, outcome })
      return outcome
    } finally {
      if (this.focusRevision === revision) this.focusRevision = null
      this.focusSending = false
    }
  }

  async editFocusMessage(request: FocusEditRequest): Promise<FocusSendOutcome> {
    if (!this.ownsFocus(request) || request.platformId !== 'chatgpt' || !request.conversationId) return 'unavailable'
    if (typeof request.text !== 'string' || !request.text.trim() || request.text.length > 20000 ||
      typeof request.messageId !== 'string' || request.messageId.length > 512) return 'invalid'
    if (this.taskRunning() || this.focusRevision) return 'busy'
    const hidden = new Set(this.focusChat.hiddenMessageIds(request.platformId, request.conversationId))
    const messages = this.options.store.listConversationMessages(request.conversationId).filter(message => !hidden.has(message.id))
    const index = messages.findIndex(message => message.id === request.messageId && message.role === 'user')
    if (index < 0) return 'unavailable'
    const message = messages[index]
    const turns = this.focusChat.turns(request.platformId, request.conversationId)
    const turnIndex = turns.findIndex(turn => turn.userMessageId === message.id)
    const turn = turns[turnIndex]
    // Attachments were not part of the measured edit interaction; retain them untouched.
    if (message.attachments.length || turn?.userAttachments?.length) return 'unavailable'
    const nextUserIndex = messages.findIndex((item, offset) => offset > index && item.role === 'user')
    const replyMessageId = turn?.segments.find(segment => segment.sourceMessageId)?.sourceMessageId || turn?.executionIds[0] ||
      messages.slice(index + 1, nextUserIndex < 0 ? undefined : nextUserIndex)
        .find(item => item.role === 'assistant' && item.sourceMessageId)?.sourceMessageId || null
    const revision = { token: randomUUID(), platformId: request.platformId, conversationId: request.conversationId,
      turnIds: (turnIndex >= 0 ? turns.slice(turnIndex) : turns.filter(item => item.createdAt >= message.createdAt)).map(item => item.id),
      messageIds: messages.slice(index).map(item => item.id), acknowledged: false }
    this.focusSending = true
    this.focusRevision = revision
    writeFocusDiagnostic(request, { event: 'edit-request', messageId: request.messageId, inputLength: request.text.length })
    try {
      const result = await this.embed.editFocusUser({ token: revision.token, originalText: turn?.userText ?? message.content,
        text: request.text, replyMessageId }, details => writeFocusDiagnostic(request, { ...details, event: 'edit-page' }))
      const outcome = result === 'ok' && !revision.acknowledged ? 'stuck' : result
      if (result === 'ok' && !revision.acknowledged) writeFocusDiagnostic(request, { event: 'edit-page', stage: 'confirm', reason: 'ack-missing' })
      writeFocusDiagnostic(request, { event: 'edit-outcome', outcome })
      return outcome
    } catch {
      writeFocusDiagnostic(request, { event: 'edit-outcome', outcome: 'stuck' })
      return 'stuck'
    } finally {
      if (this.focusRevision === revision) this.focusRevision = null
      this.focusSending = false
    }
  }

  async endTask() {
    this.focusUploadAbort?.abort()
    const platformId = this.activePlatformId
    const focusTurnId = this.focusChat.currentTurnId(platformId)
    this.deferredCommands.clear()
    const conversationId = this.embed.getState().conversationId
    if (conversationId) this.backgroundTaskResults.cancel({ platformId: this.activePlatformId, conversationId })
    const runner = this.runner.endTask()
    const status = await this.embed.endTask()
    await runner
    if (focusTurnId) this.focusChat.stop(platformId, focusTurnId)
    if (supportsFocusView(platformId)) writeFocusDiagnostic({ sessionId: this.id, platformId, conversationId }, { event: 'end-task' })
    return status
  }

  private handleDetectedCommand(command: ParsedAction): void {
    try {
      if (this.runner.handleDetected(command)) return
    } catch (error) {
      this.traceCommand(this.activePlatform, {
        event: 'error', reason: 'exception', messageId: command.messageId,
        errorType: error instanceof Error ? error.name : 'Other'
      })
      throw error
    }

    // New chats navigate from '/' to /c/<id> asynchronously. A fast assistant
    // reply can therefore be detected before getState() exposes its conversation
    // id. Keep the command by message id and associate it when onConversation has
    // persisted the new chat, rather than losing it permanently.
    this.deferredCommands.set(command.messageId, command)
    this.traceCommand(this.activePlatform, {
      event: 'deferred', reason: 'missing-conversation', messageId: command.messageId,
      waiting: this.deferredCommands.size
    })
    /*
     * A deferred command is in limbo, and until now it was in limbo silently â€” if the
     * conversation id never arrives, it is simply never heard from again.
     */
    console.info(
      `[session] command DEFERRED until a conversation id exists ` +
        `${JSON.stringify({ messageId: command.messageId, waiting: this.deferredCommands.size })}`
    )
  }

  private traceCommand(platform: ChatPlatform, details: CommandDiagnostic): void {
    try {
      const entry = this.embeds.get(platform.id)
      const state = entry?.embed?.getState()
      writeCommandDiagnostic(platform.id, details, {
        sessionId: this.id, conversationId: state?.conversationId ?? null,
        appVersion: app.getVersion(), pageUrl: state?.url ?? entry?.url ?? ''
      })
    } catch { /* Diagnostics must never interrupt the command loop. */ }
  }

  private fileReadContext(): FileReadContext {
    if (this.web2term) throw new Error('web2term 当前支持终端命令，read_files 文件传输尚未接入。请使用终端命令读取远端文件。')
    if (!fileReadingPlatform(this.activePlatform.id)) throw new Error('当前平台尚未适配 read_files。')
    const ssh = this.ssh.getState()
    if (ssh.attached) {
      return { scope: 'ssh', hostId: ssh.hostId ?? '', cwd: this.remoteShell?.cwd || this.sshCwd }
    }
    return { scope: 'local', hostId: '', cwd: this.runner.getTerminalState().cwd || homedir() }
  }

  private toolPrompt(platformId: string): string { return toolPromptForPlatform(platformId, !this.web2term) }

  private flushDeferredCommands(conversationId: string): void {
    if (this.deferredCommands.size === 0) return
    const before = this.deferredCommands.size
    for (const [messageId, command] of this.deferredCommands) {
      if (this.runner.handleDetected(command, conversationId)) {
        this.deferredCommands.delete(messageId)
        this.traceCommand(this.activePlatform, {
          event: 'deferred-flush', messageId, ownerConversationId: conversationId,
          waiting: this.deferredCommands.size
        })
      }
    }
    console.info(
      `[session] flushed deferred commands for ${conversationId}: ` +
        `${before - this.deferredCommands.size}/${before} accepted, ` +
        `${this.deferredCommands.size} still waiting`
    )
  }

  private captureConversationMessage(
    platformId: string,
    role: 'user' | 'assistant',
    text: string,
    sourceMessageId: string | null,
    attachments: ConversationImageAttachmentInput[] = [],
    focusTurnId?: string
  ): void {
    if (text.trim() === '' && attachments.length === 0) return
    const conversationId = this.embeds.get(platformId)?.conversationId ?? null
    if (conversationId) {
      const savedId = this.options.store.appendConversationMessage(
        conversationId,
        role,
        text,
        sourceMessageId,
        Date.now(),
        attachments
      )
      if (role === 'user') {
        this.focusChat.linkUser(platformId, focusTurnId, savedId)
        if (supportsFocusView(platformId)) writeFocusDiagnostic({ sessionId: this.id, platformId, conversationId },
          { event: 'user-stored', turnId: focusTurnId, messageId: savedId, attachmentCount: attachments.length,
            savedAttachmentCount: savedId ? this.options.store.countMessageAttachments(savedId) : 0 })
      }
      return
    }
    const pending = this.pendingConversationMessages.get(platformId) ?? []
    pending.push({ role, text, sourceMessageId, attachments, focusTurnId })
    this.pendingConversationMessages.set(platformId, pending)
  }

  private flushPendingConversationMessages(platformId: string, conversationId: string): void {
    const pending = this.pendingConversationMessages.get(platformId)
    if (!pending || pending.length === 0) return
    for (const message of pending) {
      const savedId = this.options.store.appendConversationMessage(
        conversationId,
        message.role,
        message.text,
        message.sourceMessageId,
        Date.now(),
        message.attachments
      )
      if (message.role === 'user') {
        this.focusChat.linkUser(platformId, message.focusTurnId, savedId)
        if (supportsFocusView(platformId)) writeFocusDiagnostic({ sessionId: this.id, platformId, conversationId },
          { event: 'user-stored', turnId: message.focusTurnId, messageId: savedId, attachmentCount: message.attachments.length,
            savedAttachmentCount: savedId ? this.options.store.countMessageAttachments(savedId) : 0 })
      }
    }
    this.pendingConversationMessages.delete(platformId)
  }
  /**
   * Remember what the user asked for.
   *
   * Called on EVERY interceptor push, because that is the only place the page reports
   * the user's own words â€” the main process never sees the composer. The comparison
   * against the previous value is what keeps it from being a write per event, and the
   * blank check matters because a `sent` report can legitimately carry nothing.
   */
  private captureGoal(sentText: string | null): void {
    const text = (sentText ?? '').trim()
    if (text === '' || text === this.pendingGoal) return
    this.pendingGoal = text

    const conversationId = this.embed.getState().conversationId
    if (conversationId) {
      this.flushPendingGoal(conversationId)
      return
    }

    // No id yet (the first message of a new chat): `onConversation` will fire once the
    // SPA assigns one, and flushPendingGoal() writes it then.
  }

  /** Persist the captured goal, if there is one and the conversation is known. */
  private flushPendingGoal(conversationId: string): void {
    if (this.pendingGoal === '') return
    if (this.options.store.setGoal(conversationId, this.pendingGoal)) {
      this.broadcastConversations()
    }
  }

  currentMachineConversations(): Conversation[] {
    const hostId = this.environmentScope.scope === 'local' ? this.options.localMachineId : this.environmentScope.hostId
    return this.options.store.list(this.environmentScope.scope, hostId)
  }

  async refreshFromSidebar(): Promise<Conversation[]> {
    const scraped = await this.embed.scrapeConversations()
    if (scraped.length > 0) this.options.store.upsertMany(scraped)
    return this.currentMachineConversations()
  }

  applyExecutionMode(mode: ExecutionMode): AutomationState {
    const state = this.runner.setMode(mode)
    this.options.store.setSetting(SETTING_EXECUTION_MODE, mode)
    this.embed.setBaselinePolicy(mode === 'auto')
    this.send(IpcChannels.automationChanged, state)
    return state
  }

  setPaused(paused: boolean): AutomationState {
    const state = this.runner.setPaused(paused)
    this.send(IpcChannels.automationChanged, state)
    this.options.onSummaryChanged()
    return state
  }

  /** Apply to this session's current/cached platforms, and persist with its row. */
  setPromptInjectionEnabled(enabled: boolean): InterceptorStatus {
    this.promptInjectionEnabled = enabled
    for (const entry of this.embeds.values()) entry.embed?.setPromptInjectionEnabled(enabled)
    this.options.onSummaryChanged()
    return this.embed.getInterceptorStatus()
  }

  async setTerminalCwd(path: string): Promise<TerminalState> {
    const target = path.trim()
    const remote = this.remoteShell
    const previousRemoteCwd = remote?.cwd ?? ''
    const state = await this.runner.setTerminalCwd(path)

    // SSH has separate model-exec and interactive PTY channels. Mirror the cwd only
    // when the model-side cd actually changed directory, or selected the current one.
    if (remote !== null && remote === this.remoteShell && remote.alive) {
      const nextRemoteCwd = remote.cwd
      if (nextRemoteCwd !== '' && (nextRemoteCwd !== previousRemoteCwd || target === nextRemoteCwd)) {
        await this.ssh.setPtyCwd(nextRemoteCwd)
      }
    }

    await this.probeEnvironment()
    return state
  }

  /** Pace the loop without touching any stored state or the environment probe. */
  setTerminalSendDelay(seconds: number): TerminalState {
    const value = Number.isFinite(seconds) ? Math.min(Math.max(Math.floor(seconds), 0), 600) : 0
    this.preferredSendDelaySeconds = value
    const state = this.runner.setSendDelay(this.activePlatformId === DEEPSEEK_PLATFORM.id ? 4 : value)
    this.options.onSummaryChanged()
    return state
  }

  /** The live command shell determines the owner, rather than a stale environment probe. */
  private notesTarget(): Omit<TerminalNotes, 'text' | 'legacyText'> {
    if (this.web2term) {
      const directory = this.web2term.alive ? this.web2term.cwd : ''
      return { projectId: this.projectId, scope: 'ssh', hostId: this.web2term.hostId, label: this.web2term.binding.deviceName || this.web2term.binding.agentId,
        directory, directoryKey: normalizeTerminalNotesDirectory('ssh', directory) }
    }
    const ssh = this.ssh?.getState()
    if (ssh?.attached) {
      const directory = this.remoteShell?.alive ? this.remoteShell.cwd || ssh.modelCwd : ''
      return {
        projectId: this.projectId, scope: 'ssh', hostId: ssh.hostId ?? '', label: ssh.name || ssh.target || '远端主机',
        directory, directoryKey: normalizeTerminalNotesDirectory('ssh', directory)
      }
    }
    const directory = this.runner?.getTerminalState().cwd ?? this.lastPersistedLocalCwd
    return {
      projectId: this.projectId, scope: 'local', hostId: this.options.localMachineId, label: '本机',
      directory, directoryKey: normalizeTerminalNotesDirectory('local', directory)
    }
  }

  currentNotes(): TerminalNotes {
    const target = this.notesTarget()
    const store = this.options.store
    const saved = target.projectId ? store.getWorkspaceProjectNote(target.projectId)
      : store.getDirectoryNote(target.scope, target.hostId, target.directoryKey)
    const legacyText = saved === null
      ? target.scope === 'ssh' ? this.options.store.getSshNote(target.hostId) : this.options.store.getSetting(SETTING_LOCAL_NOTES) ?? ''
      : ''
    return { ...target, text: saved ?? '', legacyText }
  }

  /** Called after target changes and after another session saves this same note. */
  private refreshDirectoryNotes(force = false): void {
    if (this.disposed) return
    // Older remote sessions may establish their saved directory only after
    // reconnecting. Broadcast any inherited note to already open project chats.
    const inherited = this.projectId && this.options.store.inheritWorkspaceProjectNote(this.projectId, [this.notesTarget()])
    const notes = this.currentNotes()
    const previous = this.lastDirectoryNotes
    if (!force && !inherited && previous && terminalNotesOwnerKey(previous) === terminalNotesOwnerKey(notes)
      && previous.text === notes.text && previous.legacyText === notes.legacyText
      && previous.scope === notes.scope && previous.hostId === notes.hostId
      && previous.directory === notes.directory && previous.label === notes.label) return
    this.lastDirectoryNotes = notes
    this.environment = { ...this.environment, workingDirectory: notes.directory, extraNotes: notes.text }
    for (const entry of this.embeds.values()) {
      entry.embed?.setPromptParts(buildTerminalPromptParts(this.environment, this.toolPrompt(entry.platform.id)))
    }
    this.send(IpcChannels.terminalNotesChanged, notes)
    this.send(IpcChannels.environmentChanged, { ...this.environment })
    if (inherited) this.options.onTerminalNotesSaved(notes)
  }

  refreshTerminalNotesForOwner(owner: TerminalNotesOwner): void {
    if (!this.disposed && terminalNotesOwnerKey(this.notesTarget()) === terminalNotesOwnerKey(owner)) this.refreshDirectoryNotes()
  }

  applyTerminalNotes(raw: string, expectedOwner: TerminalNotesOwner): TerminalNotes {
    const target = this.notesTarget()
    if (!canEditTerminalNotes(target)) throw new Error('当前机器或工作目录尚未确定，无法保存说明。')
    if (!expectedOwner || terminalNotesOwnerKey(expectedOwner) !== terminalNotesOwnerKey(target)) {
      throw new Error('所属项目或工作目录已变化，请确认后重新保存说明。')
    }
    const text = raw.trim() === '' ? '' : raw
    if (target.projectId) this.options.store.setWorkspaceProjectNote(target.projectId, text)
    else this.options.store.setDirectoryNote(target.scope, target.hostId, target.directoryKey, text)
    this.refreshDirectoryNotes()
    this.options.onTerminalNotesSaved(target)
    return this.currentNotes()
  }

  /**
   * Every saved MySQL connection for whichever machine the terminal is driving.
   *
   * Connections describe ONE database on ONE machine, and a machine keeps a list of
   * them. The passwords are decrypted here so the dialog can show them back; they
   * never leave this process except on their way into that dialog.
   */
  listMysqlConnections(): MysqlConnectionsState {
    return this.readMysqlConnectionsState()
  }

  /**
   * Persist one connection for the machine in charge.
   *
   * A draft with no id is a new connection and gets one here, before the write — the id
   * is generated rather than read back, so the caller can open a tab on it without a
   * second round trip. An empty password keeps the stored secret.
   */
  saveMysqlConnection(draft: MysqlConnectionDraft): MysqlSaveResult {
    const machineKey = this.environmentScope.scope === 'local' ? this.options.localMachineId : this.environmentScope.hostId
    const id = typeof draft?.id === 'string' && draft.id.trim() !== '' ? draft.id.trim() : randomUUID()
    const typed = String(draft?.password ?? '')
    this.options.store.upsertMysqlConnection({
      id,
      scope: this.environmentScope.scope,
      hostId: machineKey,
      name: String(draft?.name ?? '').trim(),
      host: String(draft?.host ?? '').trim(),
      port: Number.isFinite(Number(draft?.port)) ? Math.max(1, Math.min(65535, Math.trunc(Number(draft.port)))) : 3306,
      username: String(draft?.username ?? '').trim(),
      secret: typed === '' ? '' : encryptSecret(typed),
      database: String(draft?.database ?? '').trim()
    })
    const state = this.readMysqlConnectionsState()
    this.send(IpcChannels.mysqlConnChanged, state)
    return { ...state, id }
  }

  removeMysqlConnection(id: string): MysqlConnectionsState {
    this.options.store.removeMysqlConnection(String(id ?? ''))
    const state = this.readMysqlConnectionsState()
    this.send(IpcChannels.mysqlConnChanged, state)
    return state
  }

  /** Read every stored connection for the machine in charge and decrypt its password. */
  /**
   * Ask one connection which databases it can see.
   *
   * This is the first thing in the app that actually talks to MySQL. It opens a
   * short-lived connection, runs SHOW DATABASES, and closes it — nothing is cached and
   * nothing is written, so a failure here cannot leave the stored connection changed.
   *
   * An empty password means "use the stored one" for an existing row, the same rule the
   * save path uses, so the dropdown works on a connection that was opened without
   * retyping its password.
   */
  async listMysqlDatabases(draft: MysqlConnectionDraft): Promise<MysqlDatabaseList> {
    const machineKey = this.environmentScope.scope === 'local' ? this.options.localMachineId : this.environmentScope.hostId
    const host = String(draft?.host ?? '').trim()
    if (host === '') return { ok: false, databases: [], message: '请先填写主机地址。' }

    const typed = String(draft?.password ?? '')
    let password = typed
    if (password === '' && typeof draft?.id === 'string' && draft.id.trim() !== '') {
      const stored = this.options.store
        .listMysqlConnections(this.environmentScope.scope, machineKey)
        .find((row) => row.id === draft.id.trim())
      password = stored && stored.secret !== '' ? decryptSecret(stored.secret) : ''
    }

    const rawPort = Number(draft?.port)
    const port = Number.isFinite(rawPort) && rawPort > 0 ? Math.trunc(rawPort) : 3306
    let connection: Connection | null = null
    try {
      connection = await createConnection({
        host,
        port,
        user: String(draft?.username ?? '').trim(),
        password,
        // No database: the point is to list them, and naming one that does not exist
        // would fail the connection outright.
        connectTimeout: 8000
      })
      const [rows] = await connection.query('SHOW DATABASES')
      const databases = (Array.isArray(rows) ? rows : [])
        .map((row) => {
          const record = row as Record<string, unknown>
          const value = record.Database ?? Object.values(record)[0]
          return typeof value === 'string' ? value : ''
        })
        .filter((name) => name !== '')
        .sort((left, right) => left.localeCompare(right))
      return { ok: true, databases, message: '' }
    } catch (error) {
      return { ok: false, databases: [], message: mysqlErrorMessage(error) }
    } finally {
      if (connection) await connection.end().catch(() => undefined)
    }
  }
  /**
   * Resolve the password to use for one connection draft.
   *
   * An empty password on a SAVED row means "use the stored one", the same rule the save
   * path uses. Shared by every query below so the three of them cannot drift apart.
   */
  private mysqlPasswordFor(draft: MysqlConnectionDraft): string {
    const typed = String(draft?.password ?? '')
    if (typed !== '') return typed
    const id = typeof draft?.id === 'string' ? draft.id.trim() : ''
    if (id === '') return ''
    const machineKey = this.environmentScope.scope === 'local' ? this.options.localMachineId : this.environmentScope.hostId
    const stored = this.options.store
      .listMysqlConnections(this.environmentScope.scope, machineKey)
      .find((row) => row.id === id)
    return stored && stored.secret !== '' ? decryptSecret(stored.secret) : ''
  }

  /**
   * List the tables and views inside one database.
   *
   * INFORMATION_SCHEMA rather than SHOW TABLES, because the type and the comment are
   * part of what the list has to show and SHOW TABLES returns neither. The database name
   * is bound as a parameter, not interpolated, so it cannot break the query.
   */
  async listMysqlTables(draft: MysqlConnectionDraft, database: string): Promise<MysqlTableList> {
    const host = String(draft?.host ?? '').trim()
    const db = String(database ?? '').trim()
    if (host === '') return { ok: false, tables: [], message: '请先填写主机地址。' }
    if (db === '') return { ok: false, tables: [], message: '请先选择默认数据库。' }
    const rawPort = Number(draft?.port)
    const port = Number.isFinite(rawPort) && rawPort > 0 ? Math.trunc(rawPort) : 3306
    let connection: Connection | null = null
    try {
      connection = await createConnection({
        host,
        port,
        user: String(draft?.username ?? '').trim(),
        password: this.mysqlPasswordFor(draft),
        database: db,
        connectTimeout: 8000
      })
      const [rows] = await connection.query(
        'SELECT TABLE_NAME, TABLE_TYPE, TABLE_COMMENT FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME',
        [db]
      )
      const tables = (Array.isArray(rows) ? rows : []).map((row) => {
        const record = row as Record<string, unknown>
        return {
          name: String(record.TABLE_NAME ?? ''),
          type: String(record.TABLE_TYPE ?? ''),
          comment: String(record.TABLE_COMMENT ?? '')
        }
      })
      return { ok: true, tables: tables.filter((table) => table.name !== ''), message: '' }
    } catch (error) {
      return { ok: false, tables: [], message: mysqlErrorMessage(error) }
    } finally {
      if (connection) await connection.end().catch(() => undefined)
    }
  }

  /**
   * Read a page of rows from one table.
   *
   * Capped deliberately. A viewer that pulled an entire table would hang the renderer on
   * the first large one, and the row count is not known before the query runs. Identifiers
   * are quoted with backticks and any backtick inside them is doubled, which is the escape
   * MySQL defines; a value cannot be bound in place of a table name.
   */
  async queryMysqlTable(draft: MysqlConnectionDraft, database: string, table: string): Promise<MysqlTableData> {
    const host = String(draft?.host ?? '').trim()
    const db = String(database ?? '').trim()
    const target = String(table ?? '')
    const empty = { sql: '', columns: [], columnComments: [], columnTypes: [], columnCommentsMessage: '', rows: [], rowKeys: [], rowDeleteMessage: '', columnEditable: [], truncated: false }
    if (host === '') return { ...empty, ok: false, message: '请先填写主机地址。' }
    if (db === '') return { ...empty, ok: false, message: '请先选择默认数据库。' }
    if (target.trim() === '') return { ...empty, ok: false, message: '请先选择要查看的表。' }
    const limit = 200
    const quote = (name: string): string => '`' + name.replace(/`/g, '``') + '`'
    const rawPort = Number(draft?.port)
    const port = Number.isFinite(rawPort) && rawPort > 0 ? Math.trunc(rawPort) : 3306
    let connection: Connection | null = null
    let executedSql = ''
    try {
      connection = await createConnection({
        host,
        port,
        user: String(draft?.username ?? '').trim(),
        password: this.mysqlPasswordFor(draft),
        database: db,
        // Keep server date/time text and precision; never interpret it in the machine's timezone.
        dateStrings: true,
        supportBigNumbers: true,
        bigNumberStrings: true,
        connectTimeout: 8000
      })
      executedSql = `SELECT * FROM ${quote(db)}.${quote(target)} LIMIT ${limit + 1}`
      const [rows, fields] = await connection.query({ sql: executedSql, timeout: 8000 })
      const raw = Array.isArray(rows) ? (rows as Array<Record<string, unknown>>) : []
      const truncated = raw.length > limit
      const page = truncated ? raw.slice(0, limit) : raw
      const columns = (fields ?? []).map((field) => field.name)
      let columnComments = columns.map(() => '')
      let columnTypes = columns.map(() => '')
      let columnCommentsMessage = ''
      let rowDeleteMessage = ''
      let rowKeys: Array<MysqlRowKey | null> = page.map(() => null)
      let columnEditable = columns.map(() => false)
      try {
        const metadata = await readMysqlColumnMetadata(connection, db, target)
        const descriptions = mysqlColumnDescriptions(columns, metadata)
        columnComments = descriptions.columnComments
        columnTypes = descriptions.columnTypes
        rowDeleteMessage = mysqlRowDeleteUnavailable(metadata)
        columnEditable = mysqlColumnsEditable(columns, metadata)
        if (!rowDeleteMessage) rowKeys = page.map((row) => mysqlRowKey(row, metadata))
      } catch (error) {
        columnCommentsMessage = `字段信息读取失败：${mysqlErrorMessage(error)}`
        rowDeleteMessage = '主键读取失败，暂不支持删除记录。'
      }
      const cells = page.map((row) =>
        columns.map((column, columnIndex) => formatMysqlCell(row[column], fields?.[columnIndex]))
      )
      return { ok: true, sql: executedSql, columns, columnComments, columnTypes, columnCommentsMessage, rows: cells, rowKeys, rowDeleteMessage, columnEditable, truncated, message: '' }
    } catch (error) {
      return { ...empty, ok: false, sql: executedSql, message: mysqlErrorMessage(error) }
    } finally {
      if (connection) await connection.end().catch(() => undefined)
    }
  }

  async deleteMysqlTableRow(draft: MysqlConnectionDraft, database: string, table: string, key: MysqlRowKey): Promise<MysqlRowDeleteResult> {
    const host = String(draft?.host ?? '').trim()
    const db = String(database ?? '').trim()
    const target = String(table ?? '')
    if (!host || !db || target.trim() === '') return { ok: false, affectedRows: 0, message: '请先填写连接信息并选择数据表。' }
    const rawPort = Number(draft?.port)
    let connection: Connection | null = null
    try {
      connection = await createConnection({
        host, port: Number.isFinite(rawPort) && rawPort > 0 ? Math.trunc(rawPort) : 3306,
        user: String(draft?.username ?? '').trim(), password: this.mysqlPasswordFor(draft),
        database: db, connectTimeout: 8000
      })
      return await deleteMysqlRowWithConnection(connection, db, target, key)
    } catch (error) {
      return { ok: false, affectedRows: 0, message: `删除操作失败，请刷新表数据确认当前状态：${mysqlErrorMessage(error)}` }
    } finally {
      if (connection) await connection.end().catch(() => undefined)
    }
  }

  /** Edit one cell of the record identified by its complete primary key. */
  async updateMysqlTableCell(draft: MysqlConnectionDraft, database: string, table: string, key: MysqlRowKey, column: string, value: string | null): Promise<MysqlCellUpdateResult> {
    const failed = (message: string): MysqlCellUpdateResult => ({ ok: false, message, columns: [], row: null, rowKey: null })
    const host = String(draft?.host ?? '').trim()
    const db = String(database ?? '').trim()
    const target = String(table ?? '')
    if (!host || !db || target.trim() === '') return failed('请先填写连接信息并选择数据表。')
    if (typeof column !== 'string' || column === '') return failed('请选择要编辑的字段。')
    const rawPort = Number(draft?.port)
    let connection: Connection | null = null
    try {
      connection = await createConnection({
        host, port: Number.isFinite(rawPort) && rawPort > 0 ? Math.trunc(rawPort) : 3306,
        user: String(draft?.username ?? '').trim(), password: this.mysqlPasswordFor(draft),
        database: db, connectTimeout: 8000,
        // Same rendering as the table query, so the row read back matches the grid.
        dateStrings: true, supportBigNumbers: true, bigNumberStrings: true
      })
      return await updateMysqlCellWithConnection(connection, db, target, key, column, value)
    } catch (error) {
      return failed(`更新失败：${mysqlErrorMessage(error)}`)
    } finally {
      if (connection) await connection.end().catch(() => undefined)
    }
  }

  /** Run one SQL statement against the selected database and return a bounded result preview. */
  async executeMysqlSql(draft: MysqlConnectionDraft, database: string, sql: string): Promise<MysqlSqlExecutionResult> {
    const empty = { columns: [], rows: [], affectedRows: null, truncated: false }
    const host = String(draft?.host ?? '').trim()
    const db = String(database ?? '').trim()
    const statement = String(sql ?? '').trim()
    if (!host) return { ...empty, ok: false, message: '请先填写主机地址。' }
    if (!db) return { ...empty, ok: false, message: '请先选择数据库。' }
    if (!statement) return { ...empty, ok: false, message: '请输入要执行的 SQL。' }
    if (statement.length > 100000) return { ...empty, ok: false, message: 'SQL 语句超过 100000 字符的长度限制。' }
    const rawPort = Number(draft?.port)
    const port = Number.isFinite(rawPort) && rawPort > 0 ? Math.trunc(rawPort) : 3306
    let connection: Connection | null = null
    try {
      connection = await createConnection({
        host,
        port,
        user: String(draft?.username ?? '').trim(),
        password: this.mysqlPasswordFor(draft),
        database: db,
        dateStrings: true,
        supportBigNumbers: true,
        bigNumberStrings: true,
        connectTimeout: 8000,
        multipleStatements: false
      })
      const [result, fields] = await connection.query({ sql: statement, timeout: 15000 })
      if (!Array.isArray(result)) {
        const affectedRows = typeof (result as { affectedRows?: unknown }).affectedRows === 'number'
          ? (result as { affectedRows: number }).affectedRows : 0
        return { ...empty, ok: true, affectedRows, message: '' }
      }
      const columns = (fields ?? []).map((field) => field.name)
      const limit = 200
      const truncated = result.length > limit
      const rows = (result as Array<Record<string, unknown>>).slice(0, limit).map((record) =>
        columns.map((column, columnIndex) => formatMysqlCell(record[column], fields?.[columnIndex]))
      )
      return { ok: true, columns, rows, affectedRows: null, truncated, message: '' }
    } catch (error) {
      return { ...empty, ok: false, message: mysqlErrorMessage(error) }
    } finally {
      if (connection) await connection.end().catch(() => undefined)
    }
  }

  /** Execute one CREATE TABLE statement on the selected MySQL database. */
  async createMysqlTable(draft: MysqlConnectionDraft, database: string, sql: string): Promise<{ ok: boolean; message: string }> {
    const host = String(draft?.host ?? '').trim()
    const db = String(database ?? '').trim()
    const statement = String(sql ?? '').trim()
    if (host === '') return { ok: false, message: '请先填写主机地址。' }
    if (db === '') return { ok: false, message: '请先选择默认数据库。' }
    if (!/^CREATE\s+TABLE\b/i.test(statement)) return { ok: false, message: '这里只能执行 CREATE TABLE 建表语句。' }
    const rawPort = Number(draft?.port)
    const port = Number.isFinite(rawPort) && rawPort > 0 ? Math.trunc(rawPort) : 3306
    let connection: Connection | null = null
    try {
      connection = await createConnection({
        host,
        port,
        user: String(draft?.username ?? '').trim(),
        password: this.mysqlPasswordFor(draft),
        database: db,
        connectTimeout: 8000,
        multipleStatements: false
      })
      await connection.query({ sql: statement, timeout: 15000 })
      return { ok: true, message: '' }
    } catch (error) {
      return { ok: false, message: mysqlErrorMessage(error) }
    } finally {
      if (connection) await connection.end().catch(() => undefined)
    }
  }

  /** Drop one table or view from the selected MySQL database. */
  async dropMysqlTable(draft: MysqlConnectionDraft, database: string, table: string, type: string): Promise<{ ok: boolean; message: string }> {
    const host = String(draft?.host ?? '').trim()
    const db = String(database ?? '').trim()
    const target = String(table ?? '')
    if (host === '') return { ok: false, message: '请先填写主机地址。' }
    if (db === '') return { ok: false, message: '请先选择默认数据库。' }
    if (target.trim() === '') return { ok: false, message: '请先选择要删除的表。' }
    const quote = (name: string): string => '`' + name.replace(/`/g, '``') + '`'
    // A view has to be dropped with DROP VIEW; DROP TABLE on it fails rather than guessing.
    const keyword = String(type ?? '').toUpperCase() === 'VIEW' ? 'VIEW' : 'TABLE'
    const rawPort = Number(draft?.port)
    const port = Number.isFinite(rawPort) && rawPort > 0 ? Math.trunc(rawPort) : 3306
    let connection: Connection | null = null
    try {
      connection = await createConnection({
        host,
        port,
        user: String(draft?.username ?? '').trim(),
        password: this.mysqlPasswordFor(draft),
        database: db,
        connectTimeout: 8000,
        multipleStatements: false
      })
      await connection.query({ sql: `DROP ${keyword} ${quote(db)}.${quote(target)}`, timeout: 15000 })
      return { ok: true, message: '' }
    } catch (error) {
      return { ok: false, message: mysqlErrorMessage(error) }
    } finally {
      if (connection) await connection.end().catch(() => undefined)
    }
  }

  /** Read the CREATE statement returned by MySQL, including view definitions. */
  async getMysqlTableDdl(draft: MysqlConnectionDraft, database: string, table: string): Promise<MysqlTableDdl> {
    const host = String(draft?.host ?? '').trim()
    const db = String(database ?? '').trim()
    const target = String(table ?? '')
    if (host === '') return { ok: false, ddl: '', message: '请先填写主机地址。' }
    if (db === '') return { ok: false, ddl: '', message: '请先选择默认数据库。' }
    if (target.trim() === '') return { ok: false, ddl: '', message: '请先选择要查看的表。' }
    const quote = (name: string): string => '`' + name.replace(/`/g, '``') + '`'
    const rawPort = Number(draft?.port)
    const port = Number.isFinite(rawPort) && rawPort > 0 ? Math.trunc(rawPort) : 3306
    let connection: Connection | null = null
    try {
      connection = await createConnection({
        host,
        port,
        user: String(draft?.username ?? '').trim(),
        password: this.mysqlPasswordFor(draft),
        database: db,
        connectTimeout: 8000
      })
      const [rows] = await connection.query({
        sql: `SHOW CREATE TABLE ${quote(db)}.${quote(target)}`,
        timeout: 8000
      })
      const record = Array.isArray(rows) ? rows[0] as Record<string, unknown> | undefined : undefined
      const ddl = record?.['Create Table'] ?? record?.['Create View']
      if (typeof ddl !== 'string' || ddl.trim() === '') {
        return { ok: false, ddl: '', message: '服务器未返回该表的 DDL。' }
      }
      return { ok: true, ddl, message: '' }
    } catch (error) {
      return { ok: false, ddl: '', message: mysqlErrorMessage(error) }
    } finally {
      if (connection) await connection.end().catch(() => undefined)
    }
  }

  /** Export schema only, after the user chooses one local SQL file. */
  async exportMysqlDatabaseDdl(draft: MysqlConnectionDraft, database: string): Promise<MysqlDdlExportResult> {
    const empty = { ok: false, canceled: false, tableCount: 0, filePath: '', message: '' }
    const host = String(draft?.host ?? '').trim()
    const db = String(database ?? '').trim()
    if (host === '') return { ...empty, message: '请先填写主机地址。' }
    if (db === '') return { ...empty, message: '请先选择默认数据库。' }
    let connection: Connection | null = null
    try {
      // Capture credentials before the save dialog: the active machine may change meanwhile.
      const rawPort = Number(draft?.port)
      const options = {
        host,
        port: Number.isFinite(rawPort) && rawPort > 0 ? Math.trunc(rawPort) : 3306,
        user: String(draft?.username ?? '').trim(),
        password: this.mysqlPasswordFor(draft),
        database: db,
        connectTimeout: 8000,
        multipleStatements: false
      }
      const saveOptions = {
        title: '导出全部表 DDL',
        defaultPath: db.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_') + '-ddl.sql',
        filters: [{ name: 'SQL 文件', extensions: ['sql'] }]
      }
      const window = this.window
      const destination = window && !window.isDestroyed()
        ? await dialog.showSaveDialog(window, saveOptions)
        : await dialog.showSaveDialog(saveOptions)
      if (destination.canceled || !destination.filePath) return { ...empty, canceled: true }
      if (this.disposed) return { ...empty, message: '原会话已关闭，请重新打开工具。' }

      connection = await createConnection(options)
      const exported = await readMysqlDatabaseDdl(connection, db)
      // Finish reading every table before writing, so a query failure cannot save a partial schema.
      await writeFile(destination.filePath, exported.sql, 'utf8')
      return { ok: true, canceled: false, tableCount: exported.tableCount, filePath: destination.filePath, message: '' }
    } catch (error) {
      return { ...empty, message: mysqlErrorMessage(error) }
    } finally {
      if (connection) await connection.end().catch(() => undefined)
    }
  }

  listRedisConnections(): RedisConnectionsState {
    return this.readRedisConnectionsState()
  }

  saveRedisConnection(draft: RedisConnectionDraft): RedisSaveResult {
    const connection = normalizeRedisDraft(draft)
    const machineKey = this.environmentScope.scope === 'local' ? this.options.localMachineId : this.environmentScope.hostId
    if (connection.id && !this.options.store.listRedisConnections(this.environmentScope.scope, machineKey).some((row) => row.id === connection.id)) {
      throw new Error('连接已被删除或已切换机器，请重新打开连接。')
    }
    const secret = encryptSecret(connection.password)
    if (connection.password && !secret) throw new Error('系统密码加密不可用，连接未保存。')
    const id = connection.id || randomUUID()
    this.options.store.upsertRedisConnection({
      id, scope: this.environmentScope.scope, hostId: machineKey, name: connection.name,
      host: connection.host, port: connection.port, username: connection.username,
      secret, database: connection.database, tls: connection.tls
    })
    const state = this.readRedisConnectionsState()
    this.send(IpcChannels.redisConnChanged, state)
    return { ...state, id }
  }

  removeRedisConnection(id: string): RedisConnectionsState {
    const machineKey = this.environmentScope.scope === 'local' ? this.options.localMachineId : this.environmentScope.hostId
    this.options.store.removeRedisConnection(String(id ?? ''), this.environmentScope.scope, machineKey)
    const state = this.readRedisConnectionsState()
    this.send(IpcChannels.redisConnChanged, state)
    return state
  }

  private readRedisConnectionsState(): RedisConnectionsState {
    const hostId = this.environmentScope.scope === 'local' ? this.options.localMachineId : this.environmentScope.hostId
    const connections = this.options.store.listRedisConnections(this.environmentScope.scope, hostId).map(({ secret, ...row }) => {
      const password = decryptSecret(secret)
      if (secret && !password) throw new Error('已保存的 Redis 密码无法解密，请检查系统加密服务。')
      return { ...row, password, scope: this.environmentScope.scope, hostId }
    })
    return { machineLabel: this.environmentScope.label, ownerKey: `${this.environmentScope.scope}:${hostId}`, connections }
  }

  testRedisConnection(draft: RedisConnectionDraft): Promise<RedisConnectionResult> {
    return this.redisReader.testConnection(draft)
  }

  scanRedisKeys(draft: RedisConnectionDraft, cursor: string, search: string): Promise<RedisKeyPage> {
    return this.redisReader.scanKeys(draft, cursor, search)
  }

  readRedisKey(draft: RedisConnectionDraft, keyId: string, cursor: string): Promise<RedisKeyData> {
    return this.redisReader.readKey(draft, keyId, cursor)
  }

  /* ---------------- nacos connections ---------------- */

  /** Every saved Nacos console for whichever machine the terminal is driving. */
  listNacosConnections(): NacosConnectionsState {
    return this.readNacosConnectionsState()
  }

  /**
   * Persist one console for the machine in charge.
   *
   * Same id rule as MySQL: a draft with no id is new and gets one here, so the caller can
   * open its tab without a second round trip. The address is normalized before it is
   * stored, so a saved row is always a URL the view can actually load.
   */
  saveNacosConnection(draft: NacosConnectionDraft): NacosSaveResult {
    const machineKey = this.environmentScope.scope === 'local' ? this.options.localMachineId : this.environmentScope.hostId
    const id = typeof draft?.id === 'string' && draft.id.trim() !== '' ? draft.id.trim() : randomUUID()
    const url = normalizeNacosUrl(String(draft?.url ?? '')) ?? ''
    this.options.store.upsertNacosConnection({
      id,
      scope: this.environmentScope.scope,
      hostId: machineKey,
      name: String(draft?.name ?? '').trim(),
      url,
      namespace: String(draft?.namespace ?? '').trim()
    })
    const state = this.readNacosConnectionsState()
    this.send(IpcChannels.nacosConnChanged, state)
    return { ...state, id }
  }

  removeNacosConnection(id: string): NacosConnectionsState {
    this.options.store.removeNacosConnection(String(id ?? ''))
    const state = this.readNacosConnectionsState()
    this.send(IpcChannels.nacosConnChanged, state)
    return state
  }

  private readNacosConnectionsState(): NacosConnectionsState {
    const machineKey = this.environmentScope.scope === 'local' ? this.options.localMachineId : this.environmentScope.hostId
    const connections = this.options.store.listNacosConnections(this.environmentScope.scope, machineKey).map((row) => ({
      id: row.id,
      scope: this.environmentScope.scope,
      hostId: machineKey,
      name: row.name,
      url: row.url,
      namespace: row.namespace,
      updatedAt: row.updatedAt
    }))
    return { machineLabel: this.environmentScope.label, connections }
  }

  private readMysqlConnectionsState(): MysqlConnectionsState {
    const machineKey = this.environmentScope.scope === 'local' ? this.options.localMachineId : this.environmentScope.hostId
    const connections = this.options.store.listMysqlConnections(this.environmentScope.scope, machineKey).map((row) => ({
      id: row.id,
      scope: this.environmentScope.scope,
      hostId: machineKey,
      name: row.name,
      host: row.host,
      port: row.port,
      username: row.username,
      password: row.secret === '' ? '' : decryptSecret(row.secret),
      database: row.database,
      updatedAt: row.updatedAt
    }))
    return { machineLabel: this.environmentScope.label, connections }
  }
  listSshHosts(): SshHost[] {
    return this.options.store.listSshHosts()
  }

  removeSshHost(id: string): SshHost[] {
    this.options.store.removeSshHost(id)
    return this.options.store.listSshHosts()
  }

  resetSshTerminal(): SshState {
    this.sshTerminalResetting = this.ssh.getState().status === 'connected'
    return this.ssh.resetTerminal()
  }

  connectSsh(draft: SshHostDraft, resumeCwd = ''): SshState {
    if (this.web2term) throw new Error('此会话使用 web2term，请通过 + 另建 SSH 会话。')
    const host = String(draft?.host ?? '').trim()
    const username = String(draft?.username ?? '').trim()
    const name = String(draft?.name ?? '').trim() || host
    const rawPort = Number(draft?.port)
    const port = Number.isFinite(rawPort) && rawPort > 0 && rawPort < 65536 ? rawPort : 22
    const typed = typeof draft?.password === 'string' ? draft.password : ''
    const proxy = normalizeProxy(String(draft?.proxy ?? '') || this.options.settings().sshProxy)

    if (host === '' || username === '') {
      return {
        ...EMPTY_SSH_STATE,
        status: 'error',
        attached: true,
        message: '需要填写主机地址和用户名',
        lines: [{ kind: 'error', text: '需要填写主机地址和用户名' }]
      }
    }

    const id = typeof draft?.id === 'string' && draft.id !== '' ? draft.id : randomUUID()
    const previousSshState = this.ssh.getState()
    this.options.store.upsertSshHost({
      id,
      name,
      host,
      port,
      username,
      proxy: String(draft?.proxy ?? ''),
      secret: encryptSecret(typed)
    })

    const password = typed !== '' ? typed : decryptSecret(this.options.store.getSshSecret(id))
    if (password === '') {
      const message = safeStorage.isEncryptionAvailable()
        ? '请输入密码（这台主机还没有保存过密码）'
        : '请输入密码（当前系统不支持安全保存密码，每次连接都需要重新输入）'
      return {
        ...EMPTY_SSH_STATE,
        status: 'error',
        attached: true,
        name,
        target: `${host}:${port}`,
        message,
        lines: [{ kind: 'error', text: message }]
      }
    }

    const requestedCwd = resumeCwd.trim()
    const reconnectCwd =
      requestedCwd !== '' ? requestedCwd : previousSshState.hostId === id ? this.sshCwd : ''
    return this.ssh.connect({ hostId: id, name, host, port, username, password, proxy }, reconnectCwd)
  }

  async probeEnvironment(): Promise<EnvironmentInfo> {
    if (this.web2term && !this.web2term.alive) return { ...this.environment }
    // Match CommandRunner's execution target: a web2term probe is remote even
    // though there is no SSH exec channel. Never parse it with the desktop OS fallback.
    const backend = this.web2term ?? this.remoteShell
    try {
      const { kind, result } = await this.runner.runEnvironmentProbe()
      if (this.disposed || backend !== (this.web2term ?? this.remoteShell) || (backend && !backend.alive)
        || result.rejected || result.interrupted || result.timedOut || result.sessionLost) {
        return { ...this.environment }
      }

      const sshState = this.ssh.getState()
      const info =
        backend
          ? parseRemoteEnvironment(result.output, this.web2term?.binding.deviceName ?? sshState.name ?? '', this.web2term?.binding.agentId ?? sshState.target ?? '')
          : kind === 'posix' ? parseLocalPosixEnvironment(result.output) : parseWindowsEnvironment(result.output, resolvePowerShell())

      this.environmentScope =
        backend
          ? {
              scope: 'ssh',
              hostId: this.web2term?.hostId ?? sshState.hostId ?? '',
              label: this.web2term?.binding.deviceName || sshState.name || sshState.target || '远端主机'
            }
          : { scope: 'local', hostId: '', label: '本机' }

      this.environment = info
      try { this.send(IpcChannels.redisConnChanged, this.readRedisConnectionsState()) } catch {
        // Credential failures belong to the Redis page and must not abort environment updates.
        const hostId = this.environmentScope.scope === 'local' ? this.options.localMachineId : this.environmentScope.hostId
        this.send(IpcChannels.redisConnChanged, {
          machineLabel: this.environmentScope.label, ownerKey: `${this.environmentScope.scope}:${hostId}`, connections: []
        })
      }
      this.refreshDirectoryNotes(true)
      this.broadcastConversations()
      this.options.onSummaryChanged()
      return { ...this.environment }
    } catch (error) {
      console.warn(`[env:${this.id}] probe failed:`, (error as Error).message)
      return { ...this.environment }
    }
  }

  /** True once dispose() has run. Callers holding a runtime reference across an async boundary (e.g. a late SSH event) must check this before touching state. */
  isDisposed(): boolean {
    return this.disposed
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.focusUploadAbort?.abort()
    this.focusChat.flush()
    this.backgroundTaskResults.dispose()
    this.backgroundTasks.dispose()
    this.redisReader.dispose()
    this.web2term?.dispose()
    this.active = false
    this.deferredCommands.clear()
    const window = this.window
    if (window && !window.isDestroyed()) {
      // Every view that exists, not just the active one: a platform switched away from owns a
      // live WebContents too, and destroying only the visible one would leak a running page.
      for (const entry of this.embeds.values()) entry.embed?.destroy(window)
    }
    this.ssh.dispose()
    this.embeds.clear()
    this.window = null
    this.remoteShell = null
    this.runner.disposeAll()
    this.extraTerminals.disposeAll()
  }

  /** Where the model's shell runs right now, captured before the startup command. */
  private backgroundTaskTarget(shell: ExecutionShell): BackgroundTaskTarget {
    const web2term = this.web2term
    if (shell === web2term && this.options.web2term) {
      const { agentId, deviceName, backendUrl, userId } = web2term.binding
      return this.backgroundTargetFrom({ transport: 'web2term', key: web2term.hostId, label: deviceName || agentId,
        kind: shell.kind, cwd: shell.cwd, web2term: { agentId, deviceName, backendUrl, userId } })
    }
    if (shell === this.remoteShell) {
      const state = this.ssh.getState()
      return this.backgroundTargetFrom({ transport: 'ssh', key: `ssh:${state.hostId}:${state.target}`,
        label: state.name || state.target || 'SSH', kind: shell.kind, cwd: shell.cwd,
        ssh: { hostId: state.hostId, address: state.target } })
    }
    return this.backgroundTargetFrom({ transport: 'local', key: 'local', label: '本机', kind: shell.kind, cwd: shell.cwd })
  }

  /**
   * A live observer target from its saved description — used for new tasks and, after a
   * restart, for restored ones. An SSH or Web2Term target is available only while this
   * session is connected to that same host or device; until then the task reads 状态未知.
   */
  private backgroundTargetFrom(descriptor: BackgroundTaskTargetDescriptor): BackgroundTaskTarget {
    const base = { key: descriptor.key, label: descriptor.label, transport: descriptor.transport, kind: descriptor.kind,
      cwd: descriptor.cwd, descriptor }
    const device = descriptor.web2term
    if (descriptor.transport === 'web2term' && device) {
      const web2termOptions = this.options.web2term
      const binding = { ...device, reconnect: false, cwd: '/' }
      const available = (): boolean => {
        if (this.disposed || !web2termOptions) return false
        const state = web2termOptions.connection.getState()
        return state.status === 'connected' && state.agentId === binding.agentId
          && state.auth.status === 'signed-in' && state.auth.backendUrl === binding.backendUrl
          && state.auth.user?.publicId === binding.userId
      }
      return {
        ...base, available,
        open: signal => new Promise((resolve, reject) => {
          if (!web2termOptions) { reject(new Error('任务所属的 Web2Term 设备不属于当前工作区。')); return }
          const observer = new Web2termShell(binding, web2termOptions.connection)
          let settled = false
          const finish = (error?: Error): void => {
            if (settled) return
            settled = true
            clearTimeout(timeout)
            signal.removeEventListener('abort', cancelled)
            observer.onReady = () => {}
            observer.onChanged = () => {}
            observer.onClosed = () => {}
            if (error) { observer.dispose(); reject(error) } else resolve(observer)
          }
          const cancelled = (): void => finish(new Error('后台任务观察已关闭。'))
          const timeout = setTimeout(() => finish(new Error('设备后台监控终端打开超时。')), 25000)
          observer.onReady = () => finish()
          observer.onChanged = () => {
            if (observer.transport.status === 'error') finish(new Error(observer.transport.message))
          }
          observer.onClosed = () => finish(new Error('设备后台监控终端已断开。'))
          signal.addEventListener('abort', cancelled, { once: true })
          if (signal.aborted || !available()) cancelled()
          else observer.activate()
        })
      }
    }
    const host = descriptor.ssh
    if (descriptor.transport === 'ssh' && host) {
      const available = (): boolean => !this.disposed && this.ssh.getState().status === 'connected'
        && this.ssh.getState().hostId === host.hostId && this.ssh.getState().target === host.address
      return {
        ...base, available,
        open: async () => {
          if (!available()) throw new Error('任务所属的 SSH 主机已断开。')
          return this.ssh.openExtraShell('', { onOutput: () => {}, onClosed: () => {} })
        }
      }
    }
    return { ...base, available: () => !this.disposed, open: async () => new ConversationShell({ initialCwd: descriptor.cwd }) }
  }

  /** Whether the session is on the task's own host, so a notification about it may go out now. */
  private backgroundTargetCurrent(target: BackgroundTaskTarget): boolean {
    if (!target.available()) return false
    if (target.transport === 'local') return !this.web2term && !this.ssh.getState().attached
    return target.transport === 'web2term' ? Boolean(this.web2term?.alive) : Boolean(this.remoteShell?.alive)
  }

  /** Same transport the session terminal pane is showing: web2term, an attached SSH host, or local. */
  private extraTerminalTarget(): ExtraTerminalTarget {
    const web2term = this.web2term
    if (web2term && this.options.web2term) {
      const connection = this.options.web2term.connection
      return {
        transport: 'web2term',
        label: 'web2term · ' + (web2term.binding.deviceName || '设备'),
        // Never resumed after a restart: added terminals live only as long as this runtime.
        create: () => new Web2termShell({ ...web2term.binding, reconnect: false, cwd: web2term.cwd }, connection)
      }
    }
    const ssh = this.ssh.getState()
    if (ssh.attached && ssh.status === 'connected') {
      return { transport: 'ssh', label: ssh.name || ssh.target || 'SSH', hostId: ssh.hostId, cwd: ssh.modelCwd }
    }
    return { transport: 'local', cwd: this.runner.getTerminalState().cwd || this.lastPersistedLocalCwd }
  }

  private currentConversationProject(): {
    machineScope: 'local' | 'ssh'
    hostId: string
    machineLabel: string
    name: string
    path: string
  } | null {
    const projectPath = this.environment.workingDirectory.trim()
    if (projectPath === '') return null
    const parts = projectPath.split(/[\\/]+/).filter((part) => part !== '')
    return {
      machineScope: this.environmentScope.scope,
      hostId: this.environmentScope.scope === 'local' ? this.options.localMachineId : this.environmentScope.hostId,
      machineLabel: this.environmentScope.label,
      name: parts[parts.length - 1] ?? projectPath,
      path: projectPath
    }
  }

  private broadcastConversations(): void {
    this.send(IpcChannels.conversationsChanged, this.currentMachineConversations())
  }

  private notifyQuestion(question: string, count: number): void {
    const window = this.window
    if (this.active && window && !window.isDestroyed() && window.isFocused()) return
    if (!Notification.isSupported()) return
    const summary = question.replace(/\s+/g, ' ').trim()
    const excerpt = summary.length > 140 ? `${summary.slice(0, 137)}...` : summary
    const notification = new Notification({
      title: '有问题等待回答',
      body: count > 1 ? `共 ${count} 个问题：${excerpt}` : excerpt
    })
    notification.on('click', () => this.focus())
    notification.show()
  }
  private notifyTaskCompleted(body: string): void {
    const window = this.window
    this.options.onTaskCompleted(this.id)
    if (this.active && window && !window.isDestroyed() && window.isFocused()) return
    if (!Notification.isSupported()) return
    const notification = new Notification({ title: 'Web2Term', body })
    notification.on('click', () => this.focus())
    notification.show()
  }

  private send(channel: string, payload: unknown): void {
    const window = this.window
    if (!this.active || !window || window.isDestroyed()) return
    if (channel === IpcChannels.mysqlConnChanged || channel === IpcChannels.redisConnChanged || channel === IpcChannels.nacosConnChanged || channel === IpcChannels.questionChatState || channel === IpcChannels.backgroundTasksChanged) {
      window.webContents.send(channel, payload, this.id)
    } else {
      window.webContents.send(channel, payload)
    }
  }
}
