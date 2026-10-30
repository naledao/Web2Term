import type { DesktopInputWarning, EmergencyStopState, EmergencyStopResetResult } from './emergency-stop'
import type { ReleaseNoteDetail, ReleaseNoteRead, ReleaseNoteRequest, ReleaseNotesPage, ReleaseNotesPageRequest, ReleaseNotesResult } from './release-notes'
import type { QqMailResult, QqMailSettings, QqMailSettingsDraft } from './qq-mail'
import type { ToolboxInvocation } from './toolbox'
import type { ComputerUsePreferences, ComputerUseCapability } from './computer-use'
import type { ConversationToolsOwner, ConversationToolsState, ConversationToolsUpdate } from './conversation-tools'
import type { ScheduledTasksState, ScheduledTaskDraft, ScheduledTaskAction } from './scheduled-tasks'
import type { AutonomousTaskState, TaskResumeRequest } from './autonomous-task'
import type { TaskLease } from './autonomous-task'
import type { TaskActivity, TaskObservationRequest, TaskArtifactRequest } from './task-presentation'
import type { FocusOwner, FocusChatState, FocusChatUpdate, FocusHistoryCursor, FocusSelectionRequest, FocusSendRequest, FocusEditRequest, FocusSendOutcome, FocusAttachmentInfo, FocusComposerModeRequest, FocusModelSettingsRequest, FocusModelSettingsResult } from './focus-chat'
import type { FocusUiRequest } from './focus-smart-ui'
import type { QuestionChatAction, QuestionChatState } from './deepseek-question'
import type { GithubCliState, GithubCloneProgressEvent, GithubCloneRequest, GithubCloneResult, GithubLoginTaskResult, GithubLogoutResult, GithubRepositoryPage, GithubRepositoryRequest } from './github'
import type { BackgroundTasksState, BackgroundTaskStopResult, BackgroundCommandOptions } from './background-tasks'
/**
 * Types shared between the Electron main process, the preload bridge and the
 * React renderer. Keep this module free of runtime dependencies on `electron`
 * so it can be imported from every process.
 */

import { MAX_READ_FILES } from './file-requests'

export const IpcChannels = {
  toolboxInvoke: 'toolbox:invoke',
  getAppInfo: 'app:get-info',
  releaseNotesList: 'release-notes:list',
  releaseNotesDetail: 'release-notes:detail',
  releaseNotesRead: 'release-notes:read',
  releaseNotesChanged: 'release-notes:changed',
  githubCliGetState: 'github-cli:get-state',
  githubCliOpenInstall: 'github-cli:open-install',
  githubCliLogout: 'github-cli:logout',
  githubLoginTask: 'github-cli:login-task',
  githubRepositoriesPage: 'github-repositories:page',
  githubRepositoryClone: 'github-repositories:clone',
  githubRepositoryCloneProgress: 'github-repositories:clone-progress',
  embedSetBounds: 'embed:set-bounds',
  embedSetVisible: 'embed:set-visible',
  embedSnapshot: 'embed:snapshot',
  embedCommand: 'embed:command',
  embedNavigate: 'embed:navigate',
  embedGetState: 'embed:get-state',
  focusChatGet: 'focus-chat:get',
  focusChatSend: 'focus-chat:send',
  focusChatRetrySend: 'focus-chat:retry-send',
  focusChatEdit: 'focus-chat:edit',
  focusChatUiAction: 'focus-chat:ui-action',
  focusChatComposerMode: 'focus-chat:composer-mode',
  focusChatModelSettings: 'focus-chat:model-settings',
  focusChatAsk: 'focus-chat:ask',
  embedState: 'embed:state',
  questionChatGetState: 'question-chat:get-state',
  questionChatCreate: 'question-chat:create',
  questionChatState: 'question-chat:state',
  questionChatViewport: 'question-chat:viewport',
  questionChatAction: 'question-chat:action',
  embedLoginWithEmail: 'embed:login-with-email',
  embedImportSession: 'embed:import-session',
  /**
   * Import a whole browser cookie SET rather than one token — the Google/Gemini route.
   *
   * A separate channel because the input is a different SHAPE, not a different value: the token
   * route takes one cookie, reassembled from NextAuth chunks, while a Google session is a set of
   * cookies with no chunking and no single name that decides anything.
   */
  embedImportCookieSet: 'embed:import-cookie-set',
  embedPreviewSession: 'embed:preview-session',
  embedGetAuthState: 'embed:get-auth-state',
  nacosConnList: 'nacos-conn:list',
  nacosConnSave: 'nacos-conn:save',
  nacosConnRemove: 'nacos-conn:remove',
  nacosConnChanged: 'nacos-conn:changed',
  nacosSetBounds: 'nacos:set-bounds',
  nacosSetVisible: 'nacos:set-visible',
  nacosOpen: 'nacos:open',
  nacosNavigate: 'nacos:navigate',
  nacosCommand: 'nacos:command',
  nacosClose: 'nacos:close',
  nacosGetState: 'nacos:get-state',
  nacosState: 'nacos:state',
  openChatgptExternal: 'app:open-chatgpt-external',
  conversationsList: 'conversations:list',
  conversationMessagesList: 'conversation-messages:list',
  conversationAttachmentRead: 'conversation-attachment:read',
  conversationsSync: 'conversations:sync',
  conversationsRemove: 'conversations:remove',
  conversationsMove: 'conversations:move',
  conversationsChanged: 'conversations:changed',
  interceptorGetState: 'interceptor:get-state',
  interceptorSetEnabled: 'interceptor:set-enabled',
  interceptorSetPromptInjectionEnabled: 'interceptor:set-prompt-injection-enabled',
  interceptorAnswerQuestion: 'interceptor:answer-question',
  interceptorCancelQuestion: 'interceptor:cancel-question',
  interceptorEndTask: 'interceptor:end-task',
  commandRecoveryRetry: 'interceptor:retry-command-recovery',
  interceptorEvent: 'interceptor:event',
  settingsGet: 'settings:get',
  settingsUpdate: 'settings:update',
  qqMailGet: 'qq-mail:get',
  qqMailSave: 'qq-mail:save',
  qqMailClear: 'qq-mail:clear',
  qqMailVerify: 'qq-mail:verify',
  qqMailRecipientSave: 'qq-mail:recipient-save',
  qqMailRecipientClear: 'qq-mail:recipient-clear',
  computerUseGetCapability: 'computer-use:get-capability',
  computerUseCapabilityChanged: 'computer-use:capability-changed',
  conversationToolsGet: 'conversation-tools:get',
  conversationToolsUpdate: 'conversation-tools:update',
  conversationToolsChanged: 'conversation-tools:changed',
  emergencyStopGet: 'emergency-stop:get',
  emergencyStopTrigger: 'emergency-stop:trigger',
  emergencyStopReset: 'emergency-stop:reset',
  emergencyStopChanged: 'emergency-stop:changed',
  desktopInputWarning: 'desktop:input-warning',
  autonomousTaskGet: 'autonomous-task:get',
  taskActivityGet: 'autonomous-task:activity',
  taskObservationImageGet: 'autonomous-task:observation-image',
  taskArtifactReveal: 'autonomous-task:artifact-reveal',
  autonomousTaskResume: 'autonomous-task:resume',
  autonomousTaskQuestionReopen: 'autonomous-task:question-reopen',
  autonomousTaskChanged: 'autonomous-task:changed',
  backendAuthGet: 'backend-auth:get',
  backendLoginCode: 'backend-auth:send-code',
  backendLogin: 'backend-auth:login',
  web2termGetState: 'web2term:get-state',
  web2termListDevices: 'web2term:list-devices',
  web2termRenameDevice: 'web2term:rename-device',
  web2termConnect: 'web2term:connect',
  web2termDisconnect: 'web2term:disconnect',
  web2termClose: 'web2term:close',
  web2termChanged: 'web2term:changed',
  web2termTerminalsGet: 'web2term:terminals-get',
  web2termTerminalBuffer: 'web2term:terminal-buffer',
  web2termTerminalOpen: 'web2term:terminal-open',
  web2termTerminalClose: 'web2term:terminal-close',
  web2termTerminalInput: 'web2term:terminal-input',
  web2termTerminalResize: 'web2term:terminal-resize',
  web2termTerminalsChanged: 'web2term:terminals-changed',
  web2termTerminalOutput: 'web2term:terminal-output',
  workspaceShowWeb2term: 'workspace:show-web2term',
  environmentGet: 'environment:get',
  environmentChanged: 'environment:changed',
  automationGetState: 'automation:get-state',
  automationSetMode: 'automation:set-mode',
  automationSetPaused: 'automation:set-paused',
  automationCheckNow: 'automation:check-now',
  recentCommandList: 'recent-command:list',
  recentCommandRun: 'recent-command:run',
  automationChanged: 'automation:changed',
  executionList: 'execution:list',
  focusExecutionOutput: 'focus:execution-output',
  executionRun: 'execution:run',
  executionSkip: 'execution:skip',
  executionChanged: 'execution:changed',
  terminalGetState: 'terminal:get-state',
  terminalInput: 'terminal:input',
  terminalInterrupt: 'terminal:interrupt',
  terminalReset: 'terminal:reset',
  terminalCloseWeb2term: 'terminal:close-web2term',
  terminalSetCwd: 'terminal:set-cwd',
  terminalSetSendDelay: 'terminal:set-send-delay',
  dialogSelectDirectory: 'dialog:select-directory',
  terminalChanged: 'terminal:changed',
  linuxAgentDownloadGet: 'linux-agent-download:get',
  linuxAgentDownloadStart: 'linux-agent-download:start',
  linuxAgentDownloadReveal: 'linux-agent-download:reveal',
  linuxAgentDownloadChanged: 'linux-agent-download:changed',
  extraTerminalsGet: 'extra-terminals:get',
  extraTerminalCreate: 'extra-terminals:create',
  extraTerminalInput: 'extra-terminals:input',
  extraTerminalSetCwd: 'extra-terminals:set-cwd',
  extraTerminalInterrupt: 'extra-terminals:interrupt',
  extraTerminalClose: 'extra-terminals:close',
  extraTerminalsChanged: 'extra-terminals:changed',
  backgroundTasksGet: 'background-tasks:get',
  backgroundTaskStop: 'background-tasks:stop',
  backgroundTasksChanged: 'background-tasks:changed',
  scheduledTasksGet: 'scheduled-tasks:get',
  scheduledTaskSave: 'scheduled-tasks:save',
  scheduledTaskAction: 'scheduled-tasks:action',
  scheduledTasksChanged: 'scheduled-tasks:changed',
  terminalNotesGet: 'terminal-notes:get',
  terminalNotesSet: 'terminal-notes:set',
  terminalNotesChanged: 'terminal-notes:changed',
  sshGetState: 'ssh:get-state',
  sshListHosts: 'ssh:list-hosts',
  sshConnect: 'ssh:connect',
  sshDisconnect: 'ssh:disconnect',
  sshDismiss: 'ssh:dismiss',
  sshRemoveHost: 'ssh:remove-host',
  sshInput: 'ssh:input',
  sshUploadFiles: 'ssh:upload-files',
  sshUploadsGet: 'ssh:uploads-get',
  sshUploadCancel: 'ssh:upload-cancel',
  sshUploadsChanged: 'ssh:uploads-changed',
  sshListFiles: 'ssh:list-files',
  sshCwdDebugLog: 'ssh:cwd-debug-log',
  sshDownloadFile: 'ssh:download-file',
  sshPdfPreview: 'ssh:pdf-preview',
  sshPdfPreviewCancel: 'ssh:pdf-preview-cancel',
  sshDownloadsGet: 'ssh:downloads-get',
  sshDownloadCancel: 'ssh:download-cancel',
  sshDownloadsChanged: 'ssh:downloads-changed',
  sshTransfersGet: 'ssh:transfers-get',
  sshTransferCancel: 'ssh:transfer-cancel',
  sshTransfersChanged: 'ssh:transfers-changed',
  sshChanged: 'ssh:changed',
  managerSessionsList: 'manager:sessions-list',
  managerSessionCreate: 'manager:session-create',
  managerSessionOpen: 'manager:session-open',
  managerSessionRename: 'manager:session-rename',
  managerSessionDestroy: 'manager:session-destroy',
  managerSessionsChanged: 'manager:sessions-changed',
  managerSessionMove: 'manager:session-move',
  workspaceProjectsList: 'workspace:projects-list',
  workspaceProjectSave: 'workspace:project-save',
  workspaceProjectRemove: 'workspace:project-remove',
  workspaceProjectsChanged: 'workspace:projects-changed',
  sessionSwitchPlatform: 'session:switch-platform',
  sessionShowModelMenu: 'session:show-model-menu',
  workspaceGetState: 'workspace:get-state',
  workspaceShowManager: 'workspace:show-manager',
  workspaceSetOpenSshDialog: 'workspace:set-open-ssh-dialog',
  workspaceChanged: 'workspace:changed',
  updateGetState: 'update:get-state',
  updateCheck: 'update:check',
  updateDownload: 'update:download',
  updateInstall: 'update:install',
  updateChanged: 'update:changed',
  diagnosticLogsExport: 'diagnostics:export-logs',
  gitLog: 'git:log',
  gitDiff: 'git:diff',
  mysqlConnList: 'mysql-conn:list',
  mysqlConnSave: 'mysql-conn:save',
  mysqlConnRemove: 'mysql-conn:remove',
  mysqlConnListDatabases: 'mysql-conn:list-databases',
  mysqlConnListTables: 'mysql-conn:list-tables',
  mysqlConnQueryTable: 'mysql-conn:query-table',
  mysqlConnDeleteRow: 'mysql-conn:delete-row',
  mysqlConnUpdateCell: 'mysql-conn:update-cell',
  mysqlConnExecuteSql: 'mysql-conn:execute-sql',
  mysqlConnCreateTable: 'mysql-conn:create-table',
  mysqlConnDropTable: 'mysql-conn:drop-table',
  mysqlConnTableDdl: 'mysql-conn:table-ddl',
  mysqlConnExportDdl: 'mysql-conn:export-ddl',
  mysqlConnChanged: 'mysql-conn:changed',
  redisConnList: 'redis-conn:list',
  redisConnSave: 'redis-conn:save',
  redisConnRemove: 'redis-conn:remove',
  redisConnChanged: 'redis-conn:changed',
  redisTestConnection: 'redis:test-connection',
  redisScanKeys: 'redis:scan-keys',
  redisReadKey: 'redis:read-key'
} as const

export type IpcChannel = (typeof IpcChannels)[keyof typeof IpcChannels]

/**
 * Live state of the application updater.
 *
 * `phase` drives the settings UI:
 *   idle      — nothing checked yet, or the check is done and we are current
 *   checking  — asking GitHub for the latest release
 *   available — a newer version exists and can be downloaded
 *   downloading — download in progress (`percent` is 0..100)
 *   downloaded — ready to install; `install()` restarts into it
 *   error     — see `message`
 */
export interface UpdateStatus {
  phase: 'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'error'
  /** Version offered by the server, when known. */
  version: string
  /** Download progress, 0..100. Only meaningful while downloading. */
  percent: number
  /** Human-readable detail for the error phase. */
  message: string
}

/** Outcome of saving recent diagnostic logs as one zip. */
export type DiagnosticLogsExportResult =
  | { status: 'saved'; path: string; fileCount: number; bytes: number }
  | { status: 'cancelled' }
  | { status: 'error'; message: string }

/** State of the single-window workspace shell. */
export interface WorkspaceState {
  view: 'manager' | 'session'
  sessionId: string | null
  openSshDialog: boolean
}

export interface ManagedSessionSummary {
  id: string
  /** Explicit sidebar membership; independent of the terminal's current directory. */
  projectId: string | null
  title: string
  kind: 'local' | 'ssh' | 'web2term'
  target: string
  conversationId: string | null
  /**
   * Which chat site this session drives (`'chatgpt'` / `'deepseek'` / `'claude'`).
   *
   * Persisted, not inferred: a session restored after a restart must reopen the site its
   * conversation actually lives on, and the id is also what the manager UI labels the
   * card with. Unknown ids resolve to the default platform rather than failing, so a row
   * written by a future version cannot make the app unopenable.
   */
  platformId: string
  /** True while this session has an unfinished model task. */
  taskRunning: boolean
  /** Number of completed tasks not yet viewed in this session. */
  unseenCompletedCount?: number
  createdAt: number
}

export interface WorkspaceProject {
  id: string
  name: string
  /** Empty means use the application's normal default directory for new local chats. */
  directory: string
  createdAt: number
}

export interface WorkspaceProjectDraft {
  id?: string
  name: string
  directory: string
}

export interface Web2termWorkspaceOptions {
  /** Create a separate chat instead of resuming a disconnected workspace. */
  newChat?: boolean
  projectId?: string | null
}

/** Page the embedded view opens on. */
export const EMBED_HOME_URL = 'https://chatgpt.com/'

/**
 * Where "改用邮箱登录" sends the embedded view.
 *
 * `auth.openai.com` is inside the embed's allowlist, so this hop stays in the
 * embedded session — which is the point. Email/OTP is the ONE sign-in route that
 * can complete inside an embedded user-agent: Google and Apple both refuse it
 * outright (verified: accounts.google.com answers `/v3/signin/rejected` even with a
 * patched UA and a corrected Sec-CH-UA brand list), so a provider login can never
 * establish the session the embedded view needs.
 */
export const EMBED_LOGIN_URL = 'https://auth.openai.com/log-in'

/**
 * The session cookie an imported login is written as.
 *
 * ChatGPT runs NextAuth, and the session token is the same bearer credential the
 * browser sends — it is not bound to Chrome, so a copy of it works from anywhere
 * that presents it over HTTPS on the right domain.
 *
 * `__Secure-` is part of the NAME, not a flag: a cookie by this name is only
 * accepted when it is also set `Secure`, which is why the import path always sets
 * `secure: true` and can only ever write over https.
 */
export const SESSION_COOKIE_NAME = '__Secure-next-auth.session-token'

/** What the user pastes out of their browser's DevTools. */
export interface SessionImportDraft {
  /** Cookie name. Defaults to SESSION_COOKIE_NAME in the UI. */
  name: string
  /** Cookie value, verbatim. Held in memory for the length of one call only. */
  value: string
}

/** Result of importing a browser session into the embedded partition. */
export interface SessionImportResult {
  ok: boolean
  /** Human-readable outcome, shown in the settings dialog. */
  message: string
  /**
   * Whether the embedded page looks signed in after reloading.
   *
   * A cookie can be accepted by the partition and still be expired or revoked
   * server-side, so this is the only signal that actually means "you are in".
   */
  signedIn: boolean
}

/** Whether the embedded page is currently signed in, as far as the UI can tell. */
export interface EmbedAuthState {
  signedIn: boolean
  /** Cookie names present for chatgpt.com/openai.com — never their values. */
  cookieNames: string[]
}

/** Origin used to turn the sidebar's relative `href` values into absolute URLs. */
export const CHATGPT_ORIGIN = 'https://chatgpt.com'

/**
 * Session partition for the embedded page.
 *
 * Single source of truth: the view is created with it and the proxy is applied to
 * it. Those are two different files, and a typo in either would silently give the
 * embed its own default session — no proxy, no shared cookies — with nothing
 * failing loudly. Keep it here.
 */
export const EMBED_PARTITION = 'persist:chatgpt'

/**
 * A real conversation id, by SHAPE — never "whatever slug is in the path".
 *
 * Two shapes, because two sites use them and BOTH are real:
 *
 *   UUID      `6ab156eb-1b00-83e8-b973-a6a59295a353`   ChatGPT `/c/<uuid>`, DeepSeek likewise
 *   16 hex    `d536e21cb916e6a8`                        Gemini `/app/<16 hex>`
 *
 * The Gemini shape was measured, not assumed: ten ids came back from one probe run — eight from
 * the sidebar, two from the address bar — and every one matched `^[0-9a-f]{16}$`
 * (tools/diag/gemini-dom-probe.js, 2026-09-29).
 *
 * WHY WIDENING THIS IS NOT COSMETIC. It is not only `conversationIdFromPath` that consults it:
 * `purgeInvalidIds(isConversationId)` runs at startup and DELETES rows that fail it, and the
 * sidebar scrape filters with it. A Gemini id rejected here would therefore have its stored
 * conversations removed on the next launch, and every scraped one silently dropped — which looks
 * like a broken sync rather than a validation rule.
 *
 * `google.com`-style routes also serve placeholders, so the check stays anchored and exact; the
 * path prefix in each platform's `conversationIdFromPath` is what keeps a bare 16-hex string
 * from matching somewhere it should not.
 */
const CONVERSATION_ID_RE =
  /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{16})$/i

/** True when `value` is a genuine conversation id (a UUID), not a placeholder. */
export function isConversationId(value: string): boolean {
  return CONVERSATION_ID_RE.test(value)
}

/** ChatGPT uses /c/<id> for ordinary chats and /g/<project-or-gpt>/c/<id> for nested chats. */
export function chatgptConversationIdFromPath(pathname: string): string | null {
  const match = /^\/(?:g\/[^/?#]+\/)?c\/([^/?#]+)/.exec(pathname)
  if (!match) return null
  try {
    const id = decodeURIComponent(match[1])
    return isConversationId(id) ? id : null
  } catch { return null }
}

/** Extract the conversation id from an absolute URL, or null if it is not one. */
export function conversationIdFromUrl(url: string): string | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }

  const host = parsed.hostname.toLowerCase()
  if (host !== 'chatgpt.com' && !host.endsWith('.chatgpt.com')) return null

  return chatgptConversationIdFromPath(parsed.pathname)
}

/** Payload returned by the `app:get-info` IPC handler. */
export interface AppInfo {
  name: string
  version: string
  electron: string
  chrome: string
  node: string
  v8: string
  platform: string
  arch: string
  /** True when the app is running unpackaged (`app.isPackaged === false`). */
  isDev: boolean
  /** True only when the renderer was served by the Vite dev server (HMR active). */
  usingDevServer: boolean
  userDataPath: string
}

/** Persisted user settings, edited from the in-app settings dialog. */
export type AppTheme = 'light' | 'dark'

export interface AppSettings extends ComputerUsePreferences {
  /** Overall appearance of the application chrome. */
  theme: AppTheme
  /** Effective web2term API base address, controlled by forceDefaultBackendUrl. */
  backendUrl: string
  /** Default true. Overwrite saved addresses with the built-in backend at startup and on save. */
  forceDefaultBackendUrl: boolean
  /** Software backend HTTP/WebSocket proxy. Defaults to localhost:7897; empty means direct. */
  softwareProxy: string
  /**
   * HTTP proxy for the EMBEDDED chat views, PER PLATFORM, keyed by `ChatPlatform['id']`.
   *
   * One value per site rather than one shared value. They are different destinations reached
   * through different routes — a proxy that gets to chatgpt.com is not automatically the right
   * way to reach claude.ai, and the single shared setting this replaces made that impossible to
   * express. A missing key means direct, which is also what the empty string means, so a
   * platform added later starts with no proxy rather than silently inheriting someone else's.
   *
   * Still scoped to the embed's sessions rather than the whole app: routing everything through
   * it would drag the app's own traffic along with it.
   */
  embedProxy: Record<string, string>
  /**
   * Default proxy for SSH connections.
   *
   * A separate setting from `embedProxy` on purpose — the two are unrelated
   * mechanisms (an Electron session proxy versus a socket this app dials itself),
   * and a proxy that reaches chatgpt.com is not automatically the right way to
   * reach a particular server. Individual hosts may override this.
   *
   * Empty string means direct.
   */
  sshProxy: string
  /**
   * Proxy used ONLY when downloading application updates.
   *
   * Separate from the two above because an update download hits github.com,
   * while the embed and SSH proxies point at entirely different destinations.
   * Empty string means direct.
   */
  updateProxy: string
  /** User-selected avatar stored as an image data URL. Empty string uses the default icon. */
  userAvatarDataUrl: string
  /** Original image used by the visual avatar crop editor. */
  userAvatarSourceDataUrl: string
  /** Avatar crop position inside the circular frame, as percentages. */
  userAvatarPositionX: number
  userAvatarPositionY: number
  /** Zoom level used by the visual avatar crop editor. */
  userAvatarScale: number
  /** `ChatPlatform['id']` a newly created chat starts on; switching inside the chat is unaffected. */
  defaultPlatformId: string
  /** View a newly opened conversation starts on: original page, local transcript, or focus chat. */
  defaultChatView: 'original' | 'local' | 'focus'
}

/** Everything the renderer may change; every field is optional. */
export type AppSettingsPatch = Partial<AppSettings>

export interface BackendUser {
  publicId: string
  email: string
  nickname: string
  avatarUrl: string | null
  role: string
}

/** Public account state. The access token stays in the main process. */
export interface BackendAuthState {
  backendUrl: string
  status: 'signed-out' | 'signed-in' | 'expired'
  user: BackendUser | null
  expiresAt: string | null
}

export interface BackendLoginCodeDraft {
  backendUrl: string
  email: string
}

export interface BackendLoginDraft extends BackendLoginCodeDraft {
  code: string
}

export interface Web2termConnectDraft {
  agentId: string
  deviceName?: string
}

/** Fields used by the device picker from GET /api/user/devices. */
export interface Web2termDevice {
  deviceId: string
  deviceName: string
  enabled: 0 | 1
  onlineStatus: 0 | 1
}

export interface Web2termDeviceRenameDraft {
  deviceId: string
  deviceName: string
}

/** Authenticated desktop-to-backend transport for a target device. */
export interface Web2termConnectionState {
  revision: number
  status: 'idle' | 'connecting' | 'connected' | 'disconnected' | 'error'
  auth: BackendAuthState
  webSocketUrl: string
  desktopClientId: string
  agentId: string
  deviceName: string
  connectedAt: string | null
  message: string
  logPath: string | null
}

export const EMPTY_WEB2TERM_CONNECTION: Web2termConnectionState = {
  revision: 0, status: 'idle',
  auth: { backendUrl: '', status: 'signed-out', user: null, expiresAt: null },
  webSocketUrl: '', desktopClientId: '', agentId: '', deviceName: '', connectedAt: null, message: '', logPath: null
}

export interface Web2termTerminalSize { cols: number; rows: number }
export interface Web2termTerminalSession extends Web2termTerminalSize {
  id: string
  title: string
  status: 'opening' | 'ready' | 'closing' | 'closed' | 'error' | 'disconnected'
  shell: string
  message: string
  errorCode: string
  exitCode: number | null
}
export interface Web2termTerminalsState {
  revision: number
  connectionId: string
  sessions: Web2termTerminalSession[]
}
export const EMPTY_WEB2TERM_TERMINALS: Web2termTerminalsState = { revision: 0, connectionId: '', sessions: [] }
/** Base64 preserves raw terminal bytes and UTF-8 sequences spanning output messages. */
export interface Web2termTerminalOutput {
  connectionId: string
  sessionId: string
  sequence: number
  data: string
}
export interface Web2termTerminalBuffer {
  connectionId: string
  sessionId: string
  chunks: Web2termTerminalOutput[]
  truncated: boolean
}
export interface Web2termTerminalResult {
  ok: boolean
  message: string
  sessionId: string | null
}

export type BackendAuthResult<T> =
  | { ok: true; value: T; logPath: string | null }
  | { ok: false; message: string; logPath: string | null; retryAfterSeconds?: number }

/**
 * Where the embedded page should sit, in CSS pixels relative to the top-left of
 * the window's content area. The native view is NOT a DOM element, so React
 * measures a placeholder and reports its rectangle here.
 */
export interface EmbedBounds {
  x: number
  y: number
  width: number
  height: number
}

export type EmbedCommand = 'back' | 'forward' | 'reload' | 'stop' | 'home'

/**
 * Snapshot of the Nacos console view, pushed from main to the renderer.
 *
 * The Nacos console is a plain web page (the server's own UI), so unlike the chat embed
 * there is nothing to scrape or interpret: the state exists only to drive the address bar
 * and the loading indicator.
 */
export interface NacosViewState {
  /** True once a URL has been opened and the view is attached to the window. */
  active: boolean
  url: string
  title: string
  isLoading: boolean
  canGoBack: boolean
  canGoForward: boolean
  /** Last load failure, in the page's own words. Empty while nothing has failed. */
  error: string
}

export const EMPTY_NACOS_VIEW_STATE: NacosViewState = {
  active: false,
  url: '',
  title: '',
  isLoading: false,
  canGoBack: false,
  canGoForward: false,
  error: ''
}

/** Snapshot of the embedded view, pushed from main to the renderer. */
export interface EmbedState {
  url: string
  title: string
  isLoading: boolean
  canGoBack: boolean
  canGoForward: boolean
  /** Set when the current URL is a conversation (`/c/<id>`). */
  conversationId: string | null
  /**
   * Set while the view is parked on a bot-check interstitial rather than the site itself.
   *
   * WHY THE UI HAS TO KNOW. Such a page is a NORMAL first-visit state, not a failure: measured on
   * claude.ai from an empty partition, Cloudflare's challenge took ~24 seconds to clear on its
   * own and then navigated to the real page. But an interstitial looks exactly like the site
   * having failed to load — no content, no error — so without this the only honest reading a user
   * (or an agent reading the log) can reach is "it is broken". That misreading already cost
   * several rounds here.
   *
   * Epoch milliseconds when the check was first seen, or null when there is none.
   */
  botCheckSince: number | null
}

/** The machine + working-directory project a conversation belongs to. */
export interface ConversationProject {
  id: string
  machineScope: 'local' | 'ssh'
  hostId: string
  machineLabel: string
  name: string
  path: string
}

/** A conversation row persisted in SQLite. */
export interface Conversation {
  id: string
  url: string
  title: string
  project: ConversationProject | null
  /**
   * What the USER last asked for, verbatim.
   *
   * Deliberately not derivable from anything else: the per-command `description` is
   * the model's own one-liner about a single command, and the injected prompt text is
   * what the app wraps around the message. The user's own words exist only at the
   * moment the composer is submitted, so they are captured there and stored.
   */
  goal: string
  /** Epoch milliseconds. */
  updatedAt: number
}

/** Image bytes captured from the embedded chat page after a user send. */
export interface ConversationImageAttachmentInput {
  fileName: string
  mimeType: string
  dataBase64: string
  width: number | null
  height: number | null
  sizeBytes: number
}

/** Persisted metadata for one message attachment. The bytes stay on disk. */
export interface ConversationAttachment {
  id: string
  messageId: string
  kind: 'image'
  mimeType: string
  fileName: string
  sha256: string
  width: number | null
  height: number | null
  sizeBytes: number
  ordinal: number
}
/** One clean user/assistant turn persisted for the app-owned conversation view. */
export interface ConversationMessage {
  id: string
  conversationId: string
  role: 'user' | 'assistant'
  sourceMessageId: string | null
  content: string
  attachments: ConversationAttachment[]
  createdAt: number
}
/** One entry scraped out of the page's own sidebar markup. */
export interface ScrapedConversation {
  id: string
  url: string
  title: string
}

/* ------------------------------------------------------------------ *
 * Terminal mode: the injected system prompt
 * ------------------------------------------------------------------ */

/**
 * Which dialect the machine in charge speaks — and therefore which prompt is
 * built for it.
 *
 * This is NOT the local platform: once an SSH session is attached, the machine
 * the model is driving is the remote one, and the prompt has to describe that
 * machine instead. Getting this wrong is worse than saying nothing, because the
 * model writes commands in whatever dialect the prompt claims.
 */
export type EnvironmentKind = 'windows' | 'posix'

/**
 * What the app learned about the machine the terminal is currently driving — by
 * actually asking it, rather than assuming.
 *
 * The prompt used to hard-code "Windows 11 + Windows PowerShell". That is a guess
 * about the machine, and a wrong one on Windows 10, on a Server SKU, on ARM64,
 * wherever PowerShell 7 is installed, and on every remote host reached over SSH —
 * and the model acts on it, reaching for `&&` that 5.1 rejects or for `Get-ChildItem`
 * on a Linux box.
 */
export interface EnvironmentInfo {
  /** Which prompt variant describes this machine. */
  kind: EnvironmentKind
  /** Windows: "Microsoft Windows 11 家庭中文版". POSIX: "Ubuntu 22.04.5 LTS". */
  osCaption: string
  /** Windows: "10.0.22631". POSIX: the kernel release. */
  osVersion: string
  /** Windows build number; empty on POSIX. */
  buildNumber: string
  /** e.g. "64-bit" / "x86_64". */
  architecture: string
  /** e.g. "5.1.22621.6133"; empty on POSIX. */
  powerShellVersion: string
  /** "Desktop" for 5.1, "Core" for 7+; empty on POSIX. */
  powerShellEdition: string
  /** The executable the LOCAL shell runs, e.g. "powershell.exe". */
  powerShellExe: string
  /** POSIX shell path, e.g. "/bin/bash"; empty on Windows. */
  shellPath: string
  /** POSIX shell version banner, e.g. "GNU bash, version 5.1.16(1)-release". */
  shellVersion: string
  /**
   * Where the terminal was standing when it was probed.
   *
   * Part of the environment on purpose: the user can retarget the terminal, and
   * the prompt has to describe where it now is.
   */
  workingDirectory: string
  /**
   * Display name of the SSH host, when this describes a remote machine.
   *
   * For the UI ONLY — `describeTarget()` in the settings dialog. **Never
   * interpolate this into the prompt**: it is whatever the user called the
   * machine, and that label is frequently more revealing than the address.
   */
  remoteName: string
  /**
   * "user@host:port" of the SSH host, when this describes a remote machine.
   *
   * For the UI only, for the same reason as `remoteName`. The model gains nothing
   * from knowing the address, and it would be handed to a third-party chat.
   */
  remoteTarget: string
  /** False when detection failed; the descriptive fields are then placeholders. */
  detected: boolean
  /** Capability of this terminal's machine, never inherited from the desktop by a remote target. */
  ripgrep?: 'available' | 'missing' | 'unknown'
  /**
   * Free-form text the user attached to THIS machine.
   *
   * Appended to the very end of the prompt and given precedence over the generic
   * guidance — see `buildTerminalPrompt`. '' means nothing was written.
   */
  extraNotes: string
}

export const FALLBACK_ENVIRONMENT: EnvironmentInfo = {
  kind: 'windows',
  osCaption: 'Windows',
  osVersion: '',
  buildNumber: '',
  architecture: '',
  powerShellVersion: '',
  powerShellEdition: '',
  powerShellExe: 'powershell.exe',
  shellPath: '',
  shellVersion: '',
  workingDirectory: '',
  remoteName: '',
  remoteTarget: '',
  detected: false,
  ripgrep: 'unknown',
  extraNotes: ''
}

/**
 * The part of the prompt that does not depend on which machine is in charge.
 *
 * Shared deliberately. This section is the contract the app parses, and two
 * copies of it would eventually drift — at which point one dialect silently stops
 * round-tripping and the model looks like it is ignoring instructions.
 *
 * Keep the JSON example valid and executable: malformed JSON or placeholder
 * commands may be copied verbatim into replies that the app parses and executes.
 *
 * Inserted verbatim into the composer, so the user sees it in the input box.
 */
/** Versioned once here: previews, full injection and per-user reminders share this contract. */
export const REPLY_PROTOCOL_VERSION = 1
export const REPLY_PROTOCOL_SECTION = [
  '【任务完成】',
  '软件通过回复格式识别下一步。是否使用工具，只决定处理方式，不改变任务结束格式。',
  '1. 当前目标已满足且必要结果已核对：回复第一行必须单独、原样写【任务完成】，从下一行开始用中文给出答案或交付结果及必要的核对说明。',
  '2. 还需要工具结果才能完成：按当前工具说明输出对应请求，等待回传后继续处理。',
  '3. 缺少影响目标的关键用户信息或授权：按 questions 格式提问，得到回答后继续原任务。',
  '4. 正在等待必要结果，或操作结果尚未确认：保持任务未完成，按真实状态继续核实。',
  '普通问答、解释、翻译、总结、写作和检索回答，完整答复当前请求时，也必须使用第1种格式；无需为此调用工具。',
  '工具请求或 questions 所在回复不混入完成标记。最终回答直接呈现用户需要的内容；除非用户询问，不解释本协议。',
  '',
  '完成格式示例（只说明格式，不代表当前任务已取得这些结果）：',
  '```text',
  '用户：把 good morning 翻译成中文。',
  '助手：',
  '【任务完成】',
  '早上好。',
  '```',
  '```text',
  '用户：列出当前目录的文件。',
  '前提：已执行目录查询，软件实际回传 README.md 和 package.json。',
  '助手：',
  '【任务完成】',
  '当前目录有 README.md 和 package.json。',
  '```'
].join('\n')

/** Carried before the user-text boundary on every later human send; never on tool results. */
export const REPLY_PROTOCOL_REMINDER = '【回复约定】目标已满足时，首行原样写【任务完成】，下一行给出答案；普通问答也适用。还需工具、用户回答或必要结果时，按对应协议继续，不标记完成。\n\n'

/** Environment/tool plans stay selective; the reply contract is present on every user turn. */
export function withReplyProtocol(prefix: string): string {
  return prefix.includes(REPLY_PROTOCOL_SECTION) ? prefix : prefix + REPLY_PROTOCOL_REMINDER
}

const OUTPUT_FORMAT_SECTION = [
  REPLY_PROTOCOL_SECTION,
  '',
  '【工作协议】',
  '需要终端操作时，依据实际结果推进；相关只读检查可合并，依赖结果的步骤等回传后再执行。不臆测结果，不无故重跑。',
  '',
  '【需要执行时】',
  '仅输出一个 JSON 代码块，命令按实际任务填写。示例：',
  '```json',
  '{"command":"pwd","description":"查看当前目录","timeout_seconds":30}',
  '```',
  'command 按当前 shell 编写；description 用中文简述目的；timeout_seconds 按预计耗时填写，为 1–1800 秒整数。',
  '字符串中的双引号、反斜杠和换行按 JSON 转义，不做 Markdown 转义。',
  '',
  '【执行方式】',
  '短时命令直接执行；长时任务、常驻服务或需脱离终端运行时，优先使用当前可用的 background_task。',
  '创建后等待软件自动回传，不自行轮询或重复启动；调用及结果约定见工具说明。',
  '必须后台运行但工具不可用时，先询问用户。',
  '',
  '【读取结果】',
  '以回传的状态、输出、退出码和目录为准；历史重跑以消息中的命令为准。',
  '按工具语义判断退出码；rg 返回 1 仅表示未命中，2 表示错误，勿因通用失败标签重复执行。',
  '空输出不代表失败，退出码未知不判成功；超时、中断或断线先核实状态，勿盲目重跑。'
].join('\n')

/**
 * The background flag is an executable API: software owns startup, registration,
 * logs and exit codes. The old output marker remains a compatibility protocol.
 */
export const backgroundTaskToolPrompt = [
  '【工具：background_task】',
  '在当前机器和目录启动独立非交互进程（无 stdin/TTY），软件负责启动、登记、日志和监控。command 写工作命令，勿自行后台化或登记；不依赖前台临时变量/函数，POSIX 用 sh 语法。',
  '',
  '仅输出一个 JSON 代码块，示例命令按实际任务填写：',
  '```json',
  '{"command":"npm run dev","description":"启动开发服务","background":true,"background_kind":"service","readiness":{"type":"auto"},"timeout_seconds":30}',
  '```',
  '',
  'background_kind：一次性任务用 "job"，常驻服务用 "service"；readiness 仅用于 service。',
  'service 的 readiness 默认 auto（ASP.NET Core/Vite）；tcp 填实际 port，http 填已有健康接口 url（目标机回环地址），勿臆造。',
  '外层 timeout_seconds 只限启动，最多 30 秒；readiness.timeout_seconds 为 10–600 秒整数，默认 120 秒，超时保留进程。任务运行不限时。',
  '创建不代表完成。job 等【后台任务执行结果】；service 等【后台服务已就绪】后继续原任务。不轮询等待或重复启动，异常按回传诊断。'
].join('\n')

/** Share the role across shells; environment and routing have their own sections. */
const ROLE_SECTION = [
  '【角色】',
  '协助用户完成当前目标。按需直接回答、查询资料或使用当前可用工具；以实际结果为依据推进，具体处理方式遵循【任务路由】。'
].join('\n')

/** Keep terminal mode from turning every kind of request into a shell command. */
const TASK_ROUTING_SECTION = [
  '【任务路由】',
  '无需外部信息或机器操作时直接回答；需外部或最新资料时，优先使用可用的搜索、工具或技能，不用终端代替资料搜索。',
  '操作当前机器、项目或执行用户指定命令时，按需使用终端。',
  '搜索对象结合上下文判断，关键范围不清再询问；需资料支撑的操作先查证。',
  '所需工具不可用时说明限制；无需终端操作时不输出 command JSON。'
].join('\n')

/** Shared clarification rules; the questions JSON pauses the task until answers return. */
const ASK_USER_SECTION = [
  '【判断与确认】',
  '目标明确且在授权范围内时直接推进；能自行核实的信息先核实。',
  '仅为影响目标的关键缺失信息、范围不明或超出授权的操作提问；已回答或已授权的事项不重复确认。',
  '提问时只输出一个 JSON 代码块，不混入命令或其他调用：',
  '```json',
  '{"type":"questions","questions":[{"question":"需要确认的问题","options":["选项A","选项B"]}]}',
  '```',
  'questions 为 1–20 项；question 必填，options 最多 8 个短字符串，可省略；placeholder 可选。',
  'question 支持 Markdown；需用户执行命令时给出完整代码块，保留换行和缩进，JSON 中换行写 \\n。'
].join('\n')

export interface FileReadingPlatform {
  id: 'chatgpt' | 'deepseek' | 'claude' | 'gemini'
  label: string
}

/** Shared gate for prompt injection, request handling and attachment delivery. */
export function fileReadingPlatform(platformId: string): FileReadingPlatform | null {
  if (platformId === 'chatgpt') return { id: 'chatgpt', label: 'ChatGPT' }
  if (platformId === 'deepseek') return { id: 'deepseek', label: 'DeepSeek' }
  if (platformId === 'claude') return { id: 'claude', label: 'Claude' }
  if (platformId === 'gemini') return { id: 'gemini', label: 'Gemini' }
  return null
}

/** Tool descriptions live alongside the system prompt, with a separate preview. */
export const readFilesToolPrompt = [
  '【工具：read_files】',
  '将当前终端对应机器上的完整原文件上传为当前会话附件，供读取源码、图片和文档；不截取、转码或修改源文件。',
  '',
  '调用时仅输出一个 JSON 代码块，不混入其他调用。示例路径按实际任务填写：',
  '```json',
  '{"type":"read_files","files":[{"path":"README.md"}],"description":"读取项目说明"}',
  '```',
  '',
  `files 为 1–${MAX_READ_FILES} 项，每项仅含 path；支持绝对路径或相对当前终端工作目录的路径，SSH 会话读取远端文件。description 用中文简述目的，不能为空。`,
  '',
  '每批仅支持非空普通文件：单个最多 20 MiB，合计最多 25 MiB；同名文件分批，文件类型以当前平台支持为准。'
].join('\n')

/** Only expose tools that the selected platform can execute. */
export function toolPromptForPlatform(platformId: string, fileReading = true, capabilityPrompt = '', backgroundTasks = true, scheduledPrompt = '', mailPrompt = ''): string {
  const platform = fileReadingPlatform(platformId)
  return platform ? [...(fileReading ? [readFilesToolPrompt] : []), ...(backgroundTasks ? [backgroundTaskToolPrompt] : []),
    ...(scheduledPrompt ? [scheduledPrompt] : []), ...(mailPrompt ? [mailPrompt] : []), ...(capabilityPrompt ? [capabilityPrompt] : [])].join('\n\n') : ''
}

/** The parts of the prompt only true of a Windows PowerShell session. */
function buildWindowsPrompt(env: EnvironmentInfo): string {
  const osName = env.osCaption.trim() === '' ? 'Windows' : env.osCaption.trim()
  const osDetail = [env.osVersion.trim(), env.architecture.trim()]
    .filter((part) => part !== '')
    .join('，')

  const executable = env.powerShellExe.trim() || 'powershell.exe'
  const shell = [executable, env.powerShellVersion.trim()]
    .filter((part) => part !== '')
    .join(' ')

  // `&&` and `||` arrived in PowerShell 7; in 5.1 they are a syntax error, so
  // telling the model to avoid them is only correct on the older one.
  //
  // When the version could not be read, the executable name still tells us which
  // one it is — assuming 5.1 purely because the probe failed would be wrong on any
  // machine that has pwsh installed.
  const major = Number.parseInt(env.powerShellVersion.split('.')[0] ?? '', 10)
  const knownVersion = Number.isFinite(major)
  const isWindowsPowerShell51 =
    major === 5 ||
    env.powerShellEdition.trim().toLowerCase() === 'desktop' ||
    (!knownVersion && !/^pwsh/i.test(executable))

  const fileIoSection = [
    '【文件读写】',
    '按原编码读写，保留 BOM、换行及末尾换行；新文件遵循项目和运行环境约定。',
    ...(isWindowsPowerShell51 ? [
      'PowerShell 5.1 不依赖默认编码；无 BOM UTF-8 写入用 [IO.File]::WriteAllText($p,$s,[Text.UTF8Encoding]::new($false))。'
    ] : [])
  ]

  return [
    ROLE_SECTION,
    '',
    TASK_ROUTING_SECTION,
    '',
    OUTPUT_FORMAT_SECTION,
    '',
    ASK_USER_SECTION,
    '',
    '【执行环境】',
    `- 系统：${osName}${osDetail === '' ? '' : `（${osDetail}）`}`,
    `- Shell：${shell}；持久、非交互。`,
    ...(env.workingDirectory.trim() === '' ? [] : [`- 当前目录：${env.workingDirectory.trim()}（以最近执行结果为准）`]),
    '- 同一会话内变量和目录跨命令保留；会话重建后重新核实。',
    '- 勿用 exit；无法非交互执行的操作交由用户。',
    '',
    '【命令规范】',
    '直接在当前 PowerShell 会话执行，勿套 powershell/pwsh -Command。',
    '语法标点用半角；PowerShell 优先用单引号，转义用反引号；JSON 单独转义。',
    '输出所需字段；大结果避免 Format-Table -AutoSize。',
    '查询 WMI 信息用 Get-CimInstance，不用 wmic。',
    ...(isWindowsPowerShell51 ? ['不支持 &&/||；顺序用 ;，成功后继续用 if ($?)。'] : []),
    '',
    ...fileIoSection
  ].join('\n')
}

/**
 * The prompt for a POSIX machine — in practice a remote host reached over SSH.
 *
 * It is a different prompt rather than the Windows one with a substitute
 * environment line: the whole vocabulary changes (cmdlets, `$env:`, `-Recurse`),
 * and a model told "Linux" while still being shown PowerShell idioms reaches for
 * a mixture of both.
 */
function buildPosixPrompt(env: EnvironmentInfo): string {
  const osName = env.osCaption.trim() === '' ? 'Linux' : env.osCaption.trim()
  const mac = /mac\s?os|darwin/i.test(osName)
  const osDetail = [env.osVersion.trim(), env.architecture.trim()]
    .filter((part) => part !== '')
    .join('，')

  const shell = [env.shellPath.trim() || '/bin/sh', env.shellVersion.trim()]
    .filter((part) => part !== '')
    .join(' ')

  const isRoot = /^(root|\/root)/.test(env.workingDirectory.trim())

  return [
    ROLE_SECTION,
    '',
    TASK_ROUTING_SECTION,
    '',
    OUTPUT_FORMAT_SECTION,
    '',
    ASK_USER_SECTION,
    '',
    '【执行环境】',
    /*
     * Nothing about WHERE this machine is, or how the app reached it.
     *
     * `remoteName` and `remoteTarget` are not interpolated, and neither is any
     * mention of SSH. The prompt is pasted into a third-party chat with every
     * message, so whatever is written here stays there — and the machine's
     * identity is none of the model's business. The name is whatever the user
     * called it ("梯子服务器" says a great deal) and the address identifies it
     * outright, while the transport is an implementation detail of this app
     * rather than of the task.
     *
     * What the model actually needs is the dialect it may write in, and
     * "Linux + bash + this directory" answers that completely.
     */
    `- 系统：${osName}${osDetail === '' ? '' : `（${osDetail}）`}`,
    `- Shell：${shell}；持久、非交互。`,
    ...(env.workingDirectory.trim() === '' ? [] : [`- 当前目录：${env.workingDirectory.trim()}（以最近执行结果为准）`]),
    `- 当前用户：${isRoot ? 'root（有完整权限，但仍要谨慎）' : '普通用户'}`,
    '- 同一会话内变量和目录跨命令保留；会话重建后重新核实。',
    '- 勿用 exit；无法非交互执行的操作交由用户。',
    '',
    '【命令规范】',
    '直接写命令，不要包 zsh -c/bash -c/sh -c；可用 &&、||、;。语法符号半角，中文不能代替语法标点。',
    '路径用正斜杠，保留原始大小写，空格路径加引号。避免 sort/uniq/column -t/tac 等收齐输入的管道。',
    '',
    '【编码】',
    '文件一律按 UTF-8 处理，不依赖 terminal locale。',
    '',
    '【优先使用】',
    `- 这是 ${mac ? 'macOS' : osName}，禁用 PowerShell/cmd 语法（Get-ChildItem、Get-CimInstance、$env:、dir /s、Remove-Item）；用当前系统工具，文件搜索遵循下方搜索规范。`,
    ...(mac ? [
      '- 使用 macOS 自带的 BSD 工具参数；不要假定有 GNU sed/grep/date/readlink，禁用 apt-get、yum、systemctl 等 Linux 专用命令。',
      '- 包管理先用 command -v brew 确认 Homebrew 可用；Apple Silicon 常见目录 /opt/homebrew，Intel 常见目录 /usr/local。不要假定 jq/python3 已安装。',
      '- zsh 的未匹配通配符会报错，find 的模式须加引号；数组和下标遵循实际 Shell 语法。'
    ] : ['- 包管理按发行版用 apt-get、dnf/yum 或 apk；结构化数据用 jq 或 python3。'])
  ].join('\n')
}

/** Inline search policy shared by every shell; availability belongs to the execution target. */
export function fileSearchPrompt(env: EnvironmentInfo): string {
  const status = env.ripgrep ?? 'unknown'
  const heading = '【文件定位与内容搜索】'
  const usage = status === 'missing'
    ? ['当前终端无 rg，使用限定范围的系统搜索；安装前询问。']
    : [
      status === 'available' ? 'rg 已就绪。' : '首次搜索先确认 rg 是否可用，可用时按下述规则执行。',
      "文件定位优先 rg --files -g '模式'；内容搜索优先 rg -n -F -- '文本' 路径。"
    ]
  return [
    heading,
    ...usage,
    '先限定目录和类型，默认排除 node_modules/.git/out；结果过多再缩小范围，隐藏或忽略文件按需包含。'
  ].join('\n')
}

/** Rebuilt after machine/directory changes; the user's notes remain the final section. */
export function buildTerminalPrompt(env: EnvironmentInfo, toolPrompt = ''): string {
  return [
    env.kind === 'posix' ? buildPosixPrompt(env) : buildWindowsPrompt(env),
    '', fileSearchPrompt(env),
    ...(toolPrompt.trim() === '' ? [] : ['', toolPrompt.trim()]),
    ...notesSection(env.extraNotes)
  ].join('\n')
}

/**
 * The user's own note about this machine, appended last.
 *
 * Two deliberate choices:
 *
 *   - **It goes last, not first.** Prompt text near the end carries more weight,
 *     and this is the most specific instruction in the whole prompt.
 *   - **It is explicitly given precedence.** The generic sections above contain
 *     concrete advice ("use apt-get", "keep intermediate values in variables")
 *     that is right on average and can be wrong on one particular machine — which
 *     is exactly why the user wrote something. Without the precedence line the
 *     model treats the note as one more suggestion among many and follows the
 *     generic rule instead, which makes the feature look broken.
 *
 * Empty notes add nothing at all: a bare heading with no content would just be
 * noise in every message.
 */
function notesSection(notes: string): string[] {
  const text = notes.trim()
  if (text === '') return []

  return [
    '',
    '【用户补充】',
    '与通用约定冲突时，以以下补充说明为准：',
    text
  ]
}

/** Blank line separating the injected prompt from what the user typed. */
export const TERMINAL_PROMPT_SEPARATOR = '\n\n'

export function buildTerminalPrefix(env: EnvironmentInfo, toolPrompt = ''): string {
  return buildTerminalPrompt(env, toolPrompt) + TERMINAL_PROMPT_SEPARATOR
}

/** Preview sections and the complete prefix share the same source. */
export interface TerminalPromptParts {
  /** Terminal instructions, environment and user notes, excluding tool descriptions. */
  basePrompt: string
  /** Tool descriptions enabled for the current platform. */
  toolPrompt: string
  /** Complete injection; tool descriptions still precede the user notes. */
  prefix: string
}

export function buildTerminalPromptParts(env: EnvironmentInfo, toolPrompt = ''): TerminalPromptParts {
  const tools = toolPrompt.trim()
  return {
    basePrompt: buildTerminalPrompt(env),
    toolPrompt: tools,
    prefix: buildTerminalPrefix(env, tools)
  }
}

/** Aggregated interceptor state kept by the main process. */
export interface InterceptorStatus extends TerminalPromptParts {
  commandRecovery?: CommandRecoveryState | null
  enabled: boolean
  /** This workspace session may append its system and tool prompts to user sends. */
  promptInjectionEnabled: boolean
  /** True once the injected script has installed itself in the page. */
  installed: boolean
  injectedCount: number
  lastSentText: string | null
  /** Epoch milliseconds when the current user goal was successfully sent. */
  taskStartedAt: number | null
  /** Epoch milliseconds when the final non-command assistant reply settled. */
  taskFinishedAt: number | null
  /** A live clarification request waiting for the user's answers. */
  pendingQuestion: PendingQuestion | null
}

export interface CommandRecoveryState {
  messageId: string
  token: number
  generation: number
  status: 'pending' | 'sent' | 'blocked' | 'failed' | 'uncertain'
  message: string
}

/** One item in a clarification request lifted out of a live assistant reply. */
export interface PendingQuestionItem {
  /** The question shown on one page of the app dialog. */
  question: string
  /** Optional input hint supplied by the model. */
  placeholder: string
  /** Optional preset answers shown between the question and the free-text box (at most 8). */
  options: string[]
}

export interface PendingQuestion {
  /** Assistant message id, used to ignore duplicate DOM scans. */
  messageId: string
  /** Questions shown one at a time in the paged app dialog. */
  questions: PendingQuestionItem[]
  /** Main-issued owner for task-scoped dialogs. Not read from model JSON. */
  taskContext?: import('./task-clarification').TaskQuestionRequest
}

/**
 * One control in the composer's toolbar, as reported by the injected script.
 *
 * The same shape `tools/diag/chatgpt-dom-probe.js` prints for its `composer toolbar buttons`
 * section, so a failure inside the app and a probe run can be read side by side. That is the
 * point: the replacement selector for a button the app failed to click is supposed to come
 * from one of these, and never from a guess.
 */
export interface InterceptorControl {
  tag: string
  testid: string
  aria: string
  disabled: boolean
  cls: string
}

/** Events reported by the injected page script (over the console bridge). */
export interface InterceptorPageEvent {
  /** Complete JSON payload of a detected command or question. */
  rawJson?: string
  event:
    | 'installed'
    | 'configured'
    | 'injected'
    | 'sent'
    | 'send-observed'
    | 'user-message'
    | 'user-image-capture'
    | 'assistant-message'
    | 'assistant-history-markdown'
    | 'question'
    /** An old (not live) question reply, reported only so it can be recorded for replay. */
    | 'question-history'
    | 'question-cleared'
    | 'task-finished'
    | 'send-failed'
    | 'send-recovery'
    | 'end-task'
    | 'inject-failed'
    | 'command'
    | 'read-files'
    | 'scheduled-task'
    | 'mail-notification'
    | 'tool-prompt-read'
    | 'computer-request'
    | 'parse-failed'
    | 'command-recovery'
    | 'scan'
    | 'reply-state'
    | 'reply-watchdog'
    /** The page's own "continue" control was pressed on a reply the server cut off. */
    | 'continue-generation'
    /** The site's own edit-and-resend: a retry of the current task, or the page asking main to press edit/send. */
    | 'native-edit'
    /** One pending focus card control asks main to deliver native mouse input. */
    | 'focus-ui-click'
    | 'focus-model-click'
    | 'sent-raw'
    | 'raw-busy'
    /** Reported by the injected theme script; see src/main/injected/theme.js. */
    | 'theme'
  count?: number
  text?: string
  /** Token for a page-side batch of user image attachments, on user-message. */
  attachmentToken?: string
  focusFiles?: FocusAttachmentInfo[]
  focusSendToken?: string
  /** Correlation and origin of a confirmed human send, never an automatic result. */
  submissionId?: string
  scheduledRunId?: string
  submissionKind?: 'goal' | 'clarification'
  /** Private question/answer provenance; never a model-facing questions parameter. */
  questionSource?: import('./task-clarification').TaskQuestionSource
  answeredQuestionId?: string
  questionReplay?: boolean
  /** Computer recognition provenance; not an executable tool call. */
  sourceSubmissionId?: string
  pagePath?: string
  computerPageEpoch?: string
  computerOutcome?: import('./computer-use').ComputerUsePageRequest['outcome']
  computerIssue?: import('./computer-use').ComputerUsePageRequest['issue']
  /** Diagnostic only; main always re-validates the raw request independently. */
  computerProtocolCode?: import('./computer-use-protocol').ComputerUseProtocolErrorCode | null
  focusEditToken?: string
  focusModelToken?: string
  /** Capture diagnostics: where the image was found and how many were read. */
  phase?: 'draft' | 'sent-turn'
  enabled?: boolean
  promptInjectionEnabled?: boolean
  prefixLength?: number
  /** Metadata for the exact submitted prefix, including the user-text separator; no prompt copy. */
  contextUsage?: { id: string; estimatedTokens: number; characters: number }
  /** Version and size of the reply contract actually carried by this human send. */
  replyProtocolVersion?: number
  replyProtocolKind?: 'full' | 'short'
  replyProtocolLength?: number
  /** Present on `sent`: this confirmed user message carried the task's prompt. */
  promptInjected?: boolean
  /** A scheduled send reused the system/tool prefix already present in this conversation. */
  conversationPromptInjected?: boolean
  /** Present on `sent` and `user-message`: ignore confirmations from an already-ended task. */
  taskPromptGeneration?: number
  /** User-send diagnostics contain flags/counts, never draft or prompt text. */
  taskPromptInjected?: boolean
  trigger?: 'enter' | 'click'
  programmatic?: boolean
  composerFound?: boolean
  targetMatchesComposer?: boolean
  defaultPrevented?: boolean
  isComposing?: boolean
  /**
   * Opening words of the prompt the PAGE holds, on `injected`.
   *
   * The prompt is stored per view in the main process, so the page can end up configured with an
   * older or generic one. Comparing this with main's own prefix is the only way to see that from
   * a log — otherwise the symptom is just "messages go out without the prompt", which is
   * indistinguishable from terminal mode being off.
   */
  prefixHead?: string
  /** Present on `command` events. */
  messageId?: string
  command?: string
  background?: boolean
  backgroundOptions?: BackgroundCommandOptions
  files?: import('./file-requests').ReadFileSpec[]
  description?: string
  /** Present on `question` events. */
  question?: string
  placeholder?: string
  options?: string[]
  /** Present on `question` events; one page is rendered for each item. */
  questions?: PendingQuestionItem[]
  /** Present on command events: absolute runtime limit selected for this command, in seconds. */
  timeoutSeconds?: number
  /** Present on `command` events: true when it answers a message we just sent. */
  live?: boolean
  /** Present on `task-finished`: true for a live model declaration of task completion. */
  completed?: boolean

  /*
   * Why a submit did not happen, on `send-failed` and `send-recovery`.
   *
   * The page already knows all of this — whether a send button existed, whether it was
   * disabled, what was left in the composer, whether a stop button was on screen, and what the
   * composer's toolbar actually contained — and used to discard every part of it, leaving the
   * main process to report a bare "stuck". That is what made "the result is in the box and
   * never sent" take a round of guessing even to describe. Diagnostic payload: nothing branches
   * on it.
   */
  attempts?: number
  /**
   * Present on `send-recovery`: retry index before the recovery action.
   * On `continue-generation`: presses made for the current reply wait.
   */
  attempt?: number
  /** On `continue-generation` / `continue-clicked` and the `native-edit` click reasons: viewport CSS-pixel point the main process clicks. */
  x?: number
  y?: number
  /** On `native-edit` / `safety-leak-failed`: which step of the automatic resend gave up. */
  step?: string
  /** Which recovery action the failing pass used, or null when none had run yet. */
  recoveryTried?: string | null
  composerKind?: string | null
  /** Content-free raw-send guard diagnostics. No draft text or toolbar labels. */
  composerTextLength?: number
  attachmentRootFound?: boolean
  attachmentCards?: number
  attachmentInputFiles?: number
  attachmentImages?: number
  attachmentUploading?: boolean
  /** What was still sitting in the composer, truncated. */
  composerLeft?: string
  sendButtonFound?: boolean
  sendButtonDisabled?: boolean | null
  sendButtonVisible?: boolean
  sendButtonInComposer?: boolean
  sendButton?: InterceptorControl | null
  stopButtonFound?: boolean
  /** Present on `end-task`: what the stop button was, when one was found at all. */
  stopButton?: InterceptorControl | null
  /** Present on `end-task`: which of `stopButtonSelectors` actually matched. */
  matchedBy?: string[]
  /**
   * Present on `end-task`: the composer control the structural fallback clicked, when no stop
   * selector matched. Null means it did not run — either a selector matched, or the guards
   * (a reply pending, and an empty composer) were not satisfied.
   */
  primaryFallback?: InterceptorControl | null
  toolbar?: InterceptorControl[]
  /** How many controls the toolbar held, when `toolbar` is a window onto both its ends. */
  toolbarCount?: number
  /** Present on `send-recovery`: the action about to be attempted. */
  action?: string

  /*
   * Present on `scan`: why a settled reply produced no command.
   *
   * Every early return between "the reply is on screen" and "a command ran" is silent, so
   * without these a model that answers with a perfectly good JSON block and gets nothing back
   * leaves no evidence anywhere. `reason` names the bail; the rest is whatever that bail needs
   * to be read — the marker a turn failed to match, the text that parsed to nothing, whether the
   * braces had balanced yet.
   */
  reason?: string
  textHead?: string
  bracesBalanced?: boolean
  /**
   * Present on `parse-failed`: how long the reply was, how many `{…}` were found in it, and the
   * candidate the JSON parser was actually given.
   *
   * `text` used to be capped at 300 characters and the user-facing hint guessed at the cause
   * ("多半是引号没转义"). That guess is wrong often enough to send the model — and the reader —
   * after the wrong thing, and 300 characters did not even reach the end of the `command` value.
   * Also on `sent-raw`: the length of the text the app sent.
   */
  textLength?: number
  /** On `sent-raw` for an attachment send: a computer observation, or files read for the model. */
  attachmentKind?: 'computer' | 'files'
  objectCount?: number
  lastObject?: string | null
  commandSource?: 'code' | 'rendered'
  parseErrorCode?: string
  parseErrorField?: string
  parseErrorOffset?: number
  parseRepair?: 'windows-path'
  parseFailureToken?: number
  recoveryStatus?: CommandRecoveryState['status']
  /** Present on `scan`/`not-assistant-turn`: the selectors that failed to match. */
  wanted?: string[]
  selectors?: string[]
  tag?: string
  cls?: string
  /** Reply diagnostics: state at the report, and before a waiting-state transition. */
  awaitingReply?: boolean
  awaitingReplyBefore?: boolean
  taskActive?: boolean
  pendingQuestionFound?: boolean
  lastHandledMessageId?: string | null
  assistantTurnCount?: number
  hiddenTurnCount?: number
  lastMatchedMessageId?: string | null
  selectedFromRenderedTurns?: boolean
  replySnapshotAvailable?: boolean
  replyTextLength?: number
  selectedNodeVisible?: boolean
  selectedReplyVisible?: boolean
  selectedNodeTextLength?: number
  replyTextContentLength?: number
  visibleAssistantTurnCount?: number
  lastVisibleMessageId?: string | null
  selectedMatchesLastVisible?: boolean
  lastVisibleReplyTextLength?: number
  lastVisibleReplyCodeBlockCount?: number
  lastVisibleReplyKind?: 'empty' | 'questions' | 'read-files' | 'command' | 'computer' | 'prose'
  visibleAnswerMarkerCount?: number
  visibleAnswerOwnerMessageId?: string | null
  visibleAnswerTextLength?: number
  visibleAnswerCodeBlockCount?: number
  visibleAnswerKind?: 'empty' | 'questions' | 'read-files' | 'command' | 'computer' | 'prose'
  visibleCodeBlockCount?: number
  lastScanAgeMs?: number | null
  lastMutationAgeMs?: number | null
  replySettlePending?: boolean
  fileSendPending?: boolean
  codeBlockCount?: number
  replyKind?: 'empty' | 'questions' | 'read-files' | 'command' | 'computer' | 'prose'
  answerMarkerFound?: boolean
  replyRootIsTurn?: boolean
  replyStreamingState?: 'true' | 'false' | 'missing' | 'unknown'
  /** `computer-not-live` only: which liveness check failed. Flags, counts and path shapes only. */
  computerLive?: Record<string, unknown>
  stopButtonOnPage?: boolean
  toolbarRootFound?: boolean

  /*
   * Present on `theme`: what the app asked the page for, what the page actually looks like,
   * and what was done about it.
   *
   * A page that ignores the app's theme and a page that has been themed correctly are
   * IDENTICAL in every other signal this app has — nothing else reads a colour or a class,
   * so "the theme sync silently did nothing" has no symptom. These fields are the symptom:
   * `page` is measured from the page's computed colours, `lever` names the hook that
   * provably moved it, and `tried` lists the hooks that did not, with what they measured.
   * `hints` is the discovery half — the site's own theme-shaped localStorage entries, which
   * is where a durable storage rule comes from.
   */
  want?: string
  page?: string
  applied?: string
  /**
   * The declared DOM mutation the page was put into, as `body/class:dark=true`.
   *
   * `mutations` lists the whole applied set: DeepSeek's dark mode is three coordinated
   * changes, and a report naming only the first would read as if one class were the whole
   * mechanism.
   */
  mutation?: string | null
  mutations?: string[]
  tried?: string[]
  declared?: number
  evidence?: string
  hints?: string[]
  storageKeys?: string[]
  retry?: number
  /** What the page believes the OS preference is; on `theme`, not `scan`. */
  query?: string
}

/* ------------------------------------------------------------------ *
 * Commands, executions and the per-conversation terminal
 * ------------------------------------------------------------------ */

export type ExecutionStatus =
  | 'pending'
  | 'blocked'
  | 'running'
  | 'interrupted'
  | 'done'
  | 'failed'
  | 'timeout'
  | 'skipped'

/** Saved complete JSON for one recently detected command. */
export interface RecentCommandJson {
  messageId: string
  payloadJson: string
  createdAt: number
}

export type RecentCommandRunResult = 'ok' | 'busy' | 'unavailable' | 'invalid' | 'paused' | 'terminal-mode-off'

/** Progress of downloading the web2term Linux tool from the client. */
export interface LinuxAgentDownloadState {
  phase: 'idle' | 'downloading' | 'done' | 'error'
  percent: number
  /** Status line while preparing, or the failure reason. */
  message: string
  /** Where the file is (or was going to be) saved. */
  path: string
}

/** A recorded clarification request (`question` / `questions`) rather than a command. */
export function isQuestionPayload(payload: unknown): boolean {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false
  const type = (payload as { type?: unknown }).type
  return type === 'question' || type === 'questions'
}

/** What 重新执行指令 keeps: a command object, or a question object to ask again. */
export function isRecentCommandPayload(payload: unknown): boolean {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false
  return typeof (payload as { command?: unknown }).command === 'string' || isQuestionPayload(payload)
}

/** One command lifted out of an assistant reply, and what happened to it. */
export interface ExecutionRecord {
  /** Assistant message id, or a unique rerun:<uuid> for an explicit history replay. */
  messageId: string
  conversationId: string
  command: string
  kind: 'command' | 'read_files' | 'invalid'
  /** Software-managed background startup rather than foreground shell execution. */
  background?: boolean
  backgroundOptions?: BackgroundCommandOptions
  fileRequest: import('./file-requests').StoredFileReadRequest | null
  deliveryStatus: import('./file-requests').FileDeliveryStatus | null
  description: string
  /** Absolute runtime limit selected for this command, in seconds. */
  timeoutSeconds: number
  status: ExecutionStatus
  exitCode: number | null
  output: string
  /** UI summaries defer full output until the user expands that execution. */
  outputDeferred?: boolean
  createdAt: number
  /** Epoch milliseconds when the command actually started running. */
  startedAt: number | null
  finishedAt: number | null
  /** Durable provenance only; restored records do not grant live task execution. null means corrupt provenance. */
  taskContext?: import('./autonomous-task').TaskToolContext | null
}

/** A command the injected script found in the page but main has not stored yet. */
export interface ParsedCommand {
  messageId: string
  command: string
  background?: boolean
  backgroundOptions?: BackgroundCommandOptions
  description: string
  /** Absolute runtime limit selected for this command, in seconds. */
  timeoutSeconds: number
  /** Complete command JSON object from the assistant reply. */
  rawJson?: string
  /**
   * The only thing that matters for safety: is this reply an answer to a message
   * the app just sent, or is it history that happened to be on screen?
   *
   * Only `live` commands are ever executed automatically. History is still
   * stored and shown, so the user can run it by hand.
   */
  live: boolean
  taskSource?: TaskActionSource
}

/** Validated page-generation/route provenance, attached by the main bridge, never parsed from tool JSON. */
export interface TaskActionSource { sourceSubmissionId: string; taskPromptGeneration: number; pagePath: string }

export type ParsedReadFiles = import('./file-requests').ReadFilesRequest & {
  messageId: string
  live: boolean
  taskSource?: TaskActionSource
}

export type ParsedAction = ParsedCommand | ParsedReadFiles

/**
 * How detected commands are handled.
 *
 * - `manual` — every command is stored and waits for a click on 运行.
 * - `auto`   — commands run as soon as they arrive.
 *
 * In BOTH modes the result is handed back to the model, and in both modes a
 * command that was already on screen when the conversation was opened is never
 * run automatically (see `armBaseline` in the injected script).
 */
export type ExecutionMode = 'auto' | 'manual'

/** Terminal-mode automation state. */
export interface AutomationState {
  mode: ExecutionMode
  /** Global stop: no command runs and no result is sent while this is true. */
  paused: boolean
}

export type TerminalLineKind = 'command' | 'output' | 'notice' | 'error'

export interface TerminalLine {
  kind: TerminalLineKind
  text: string
  /** Display-only PTY echo; history already records the original submitted input. */
  inputEcho?: boolean
}

/**
 * Snapshot of the current managed workspace's command terminal.
 * Local and web2term transports share this transcript/input UI. The persistent
 * shell belongs to the workspace rather than to an individual chat conversation.
 */
export interface TerminalState {
  /** Local dialect, or the device dialect when web2term owns this pane. */
  shellKind: EnvironmentKind
  shellLabel: string
  /** Present only when this managed session uses the web2term relay. */
  transport?: {
    kind: 'web2term'
    deviceId: string
    deviceName: string
    status: 'connecting' | 'ready' | 'closing' | 'disconnected' | 'error'
    /** Closing can be retried if the tool has not acknowledged it. */
    canClose: boolean
    message: string
    logPath: string | null
  }
  /** True while the shell can accept commands. */
  alive: boolean
  /** Current working directory reported by the shell, when known. */
  cwd: string
  lines: TerminalLine[]
  /**
   * Seconds to wait after a model-driven command finishes, before its output is
   * handed back to the model. 0 sends it straight away.
   *
   * In-memory and per session on purpose: it paces the loop, it is not a stored
   * preference, and a restart going back to 0 is the safe default.
   */
  sendDelaySeconds: number
}

/**
 * A terminal the user opened from the right panel's + menu.
 *
 * Never driven by the model: the model keeps using the one session terminal
 * above. Lives in memory with its session runtime.
 */
export interface ExtraTerminal {
  id: string
  title: string
  /** Fixed at creation from what the session terminal was connected to then. */
  transport: 'local' | 'ssh' | 'web2term'
  /** Header text, e.g. 本机 · PowerShell, or the SSH host / web2term device. */
  label: string
  /** Why a remote terminal cannot take commands right now; empty when it can. */
  message: string
  shellKind: EnvironmentKind
  alive: boolean
  running: boolean
  cwd: string
  lines: TerminalLine[]
}

export interface ExtraTerminalsState {
  terminals: ExtraTerminal[]
}

/* ------------------------------------------------------------------ *
 * SSH
 * ------------------------------------------------------------------ */

/**
 * A stored SSH target.
 *
 * The password is NOT part of this: it lives encrypted in the database, and all
 * the renderer ever learns is whether one is stored.
 */
export interface SshHost {
  id: string
  /** What the user calls this machine. */
  name: string
  host: string
  port: number
  username: string
  /**
   * Per-host proxy override. Empty means "follow the sshProxy setting".
   * (There is deliberately no way to force direct while a default is set — the
   * distinction is not worth a third state in the UI.)
   */
  proxy: string
  /** True when an encrypted password is on file for this host. */
  hasPassword: boolean
  updatedAt: number
}

/** What the connect form submits. `id` is present when updating a stored host. */
export interface SshHostDraft {
  id: string | null
  name: string
  host: string
  port: number
  username: string
  /** Empty means "use the stored password", or prompt-free failure if none. */
  password: string
  /** Empty means "use the sshProxy setting". */
  proxy: string
}

export type SshStatus = 'disconnected' | 'connecting' | 'connected' | 'error'

export interface SshFileEntry {
  /** Absolute remote path, also used as the FileManager id. */
  id: string
  name: string
  type: 'file' | 'folder'
  size: number
  /** Unix epoch milliseconds. */
  modifiedAt: number
}

export type SshUploadStatus = 'uploading' | 'completed' | 'cancelled' | 'failed'

export interface SshUploadTask {
  id: string
  name: string
  localPath: string
  remotePath: string
  status: SshUploadStatus
  transferred: number
  total: number
  startedAt: number
  finishedAt: number | null
  error: string
}

export type SshDownloadStatus = 'downloading' | 'completed' | 'cancelled' | 'failed'

export interface SshDownloadTask {
  id: string
  name: string
  remotePath: string
  localPath: string
  status: SshDownloadStatus
  transferred: number
  total: number
  startedAt: number
  finishedAt: number | null
  error: string
}

export type SshTransferDirection = 'upload' | 'download'

export interface SshTransferTask {
  sessionId: string
  direction: SshTransferDirection
  id: string
  name: string
  localPath: string
  remotePath: string
  status: SshUploadStatus | SshDownloadStatus
  transferred: number
  total: number
  startedAt: number
  finishedAt: number | null
  error: string
}

export interface SshState {
  status: SshStatus
  /**
   * True from the moment a connection is attempted until the user dismisses it.
   *
   * The pane keeps showing the SSH transcript while attached — including after a
   * failure, so the error is readable instead of vanishing.
   */
  attached: boolean
  /** Display name / address of the attached host, for the header. */
  name: string
  target: string
  /**
   * Id of the stored host this session came from, or '' when there is none.
   *
   * The host picker marks the active row by id rather than by address: two saved
   * entries may well point at the same machine under different users or ports, and
   * "which of these am I currently on" has to have exactly one answer.
   */
  hostId: string
  /** Human-readable status or failure reason. */
  message: string
  /**
   * True once this host has taken over command execution.
   *
   * From that moment the model's commands run HERE, not on the local machine, and
   * the injected prompt describes this host. The two must agree: a prompt that
   * says Linux while PowerShell executes would send the model straight into
   * commands that cannot work.
   */
  remoteExec: boolean
  /**
   * Working directory of the shell that runs the MODEL's commands.
   *
   * Used by the workbench while remoteExec is true. The independent interactive
   * PTY directory is tracked separately; manual directory changes are mirrored
   * to the model shell when that shell can accept them.
   */
  modelCwd: string
  /**
   * Working directory of the interactive PTY the user types into, parsed from
   * the shell prompt. Kept apart from `modelCwd` because the two are different
   * shells: this one moves the moment the user runs `cd` by hand.
   */
  ptyCwd: string
  lines: TerminalLine[]
}

/* ------------------------------------------------------------------ *
 * Project notes, or per-directory notes for chats outside a project
 * ------------------------------------------------------------------ */

/**
 * Project chats share one note regardless of their terminal's machine or directory.
 * Chats outside projects share notes only for the same machine and exact directory.
 */
export interface TerminalNotesOwner {
  /** Sidebar project, when present; takes precedence over the terminal directory. */
  projectId?: string | null
  /** Which kind of machine owns this note. */
  scope: 'local' | 'ssh'
  /** Saved SSH host id, or the installation's local machine id. */
  hostId: string
  /** Normalized absolute cwd; empty until the shell establishes its directory. */
  directoryKey: string
}

export function terminalNotesOwnerKey(owner: TerminalNotesOwner): string {
  if (owner.projectId) return JSON.stringify(['project', owner.projectId])
  return JSON.stringify([owner.scope, owner.hostId, owner.directoryKey])
}

export function canEditTerminalNotes(owner: TerminalNotesOwner | null): boolean {
  return Boolean(owner && (owner.projectId || (owner.hostId && owner.directoryKey)))
}

export interface TerminalNotes extends TerminalNotesOwner {
  /** Who it belongs to, for the editor's title. */
  label: string
  /** Current shell cwd, in the spelling shown to the user. */
  directory: string
  /** The note itself. '' when nothing has been written. */
  text: string
  /** Retained old machine-level note, offered for explicit import into an unset directory. */
  legacyText: string
}

/**
 * One saved MySQL connection.
 *
 * A machine keeps a LIST of these rather than one row. A single row per machine cannot
 * describe the ordinary case of a local MySQL next to a staging one, and it turned the
 * connection dialog into a form that overwrote itself.
 *
 * scope + hostId say which machine the row belongs to; id is the row own identity, and it
 * is what the dialog tabs are keyed by.
 */
export interface MysqlConnection {
  /** Stable row id. */
  id: string
  /** Which machine this connection belongs to. */
  scope: 'local' | 'ssh'
  /** The saved host id when scope is ssh; the local machine id otherwise. */
  hostId: string
  /** What the user calls this connection; shown on its tab. */
  name: string
  host: string
  port: number
  username: string
  /** Stored encrypted, like the SSH password. Never logged. */
  password: string
  database: string
  /** Epoch milliseconds of the last save. */
  updatedAt: number
}

/** What the connection form submits. id is empty for a connection that was never saved. */
export interface MysqlConnectionDraft {
  id: string
  name: string
  host: string
  port: number
  username: string
  /** Empty means keep the password already stored for this row. */
  password: string
  database: string
}

/** Every saved connection for one machine, plus whose machine it is. */
/** Result of asking a connection which databases it can see. */
export interface MysqlDatabaseList {
  ok: boolean
  /** Database names, sorted; empty when ok is false. */
  databases: string[]
  /** Human-readable failure reason, shown in the dropdown itself. */
  message: string
}/** One table or view inside a database, as shown under a connection. */
export interface MysqlTableInfo {
  name: string
  /** MySQL wording: 'BASE TABLE' or 'VIEW'. */
  type: string
  /** The table comment, empty when it has none. */
  comment: string
}

/** Result of asking a database which tables it holds. */
export interface MysqlTableList {
  ok: boolean
  tables: MysqlTableInfo[]
  message: string
}

/** An exact primary-key value, separate from the rendered cell text. */
export interface MysqlRowKeyPart {
  column: string
  value: string
  /** Binary primary keys keep their actual bytes instead of the display placeholder. */
  encoding: 'text' | 'hex'
}

export type MysqlRowKey = MysqlRowKeyPart[]

export interface MysqlRowDeleteResult {
  ok: boolean
  affectedRows: number
  message: string
}

/** Result of editing one cell; the row as the server now stores it, when it could be read back. */
export interface MysqlCellUpdateResult {
  ok: boolean
  message: string
  /** Column names of `row`; empty when the row was not read back. */
  columns: string[]
  row: Array<string | null> | null
  /** The row's key after the update (it changes when a primary-key column was edited). */
  rowKey: MysqlRowKey | null
}

/** One page of rows from a table, for the table viewer. */
export interface MysqlTableData {
  ok: boolean
  /** The exact data query sent to MySQL; empty if no query was attempted. */
  sql: string
  /** Column names, in the order the server returned them. */
  columns: string[]
  /** Database comments aligned with columns; an empty string means no comment. */
  columnComments: string[]
  /** Full MySQL types aligned with columns (e.g. varchar(255)); empty means unavailable. */
  columnTypes: string[]
  /** A non-fatal failure reading field metadata; row data remains available. */
  columnCommentsMessage: string
  /** Each row cells, already rendered as text. A SQL NULL stays null. */
  rows: Array<Array<string | null>>
  /** Complete primary keys aligned with rows; null means this row cannot be deleted. */
  rowKeys: Array<MysqlRowKey | null>
  /** Why deletion is unavailable for this table, empty when primary keys are readable. */
  rowDeleteMessage: string
  /** Aligned with columns: whether a cell can be edited in place (needs a primary key, not binary). */
  columnEditable: boolean[]
  /** True when the table held more rows than the viewer asked for. */
  truncated: boolean
  message: string
}
/** Result of a single SQL statement executed in the selected MySQL database. */
export interface MysqlSqlExecutionResult {
  ok: boolean
  columns: string[]
  rows: Array<Array<string | null>>
  affectedRows: number | null
  truncated: boolean
  message: string
}

/** The server's CREATE statement for one table or view. */
export interface MysqlTableDdl {
  ok: boolean
  ddl: string
  message: string
}

export interface MysqlDdlExportResult {
  ok: boolean
  canceled: boolean
  tableCount: number
  filePath: string
  message: string
}

export interface MysqlConnectionsState {
  /** Display name of the machine these belong to, for the dialog header. */
  machineLabel: string
  connections: MysqlConnection[]
}

/** Result of saving one connection: the row written, and the machine list afterwards. */
export interface MysqlSaveResult extends MysqlConnectionsState {
  /** Id of the row that was written. A new connection gets its id here. */
  id: string
}

/** Saved connection metadata. Redis data is only read through the APIs below. */
export interface RedisConnectionDraft {
  id: string
  name: string
  host: string
  port: number
  username: string
  password: string
  database: number
  tls: boolean
}

export interface RedisConnection extends RedisConnectionDraft {
  scope: 'local' | 'ssh'
  hostId: string
  updatedAt: number
}

export interface RedisConnectionsState {
  machineLabel: string
  /** Discards pages when the session switches machines. */
  ownerKey: string
  connections: RedisConnection[]
}

export interface RedisSaveResult extends RedisConnectionsState {
  id: string
}

export interface RedisConnectionResult {
  ok: boolean
  message: string
}

export interface RedisKeyInfo {
  /** Exact key bytes encoded as base64, including binary keys. */
  id: string
  name: string
  type: string
  /** Milliseconds; -1 means persistent, -2 means missing, null means unavailable. */
  ttl: number | null
}

export interface RedisKeyPage {
  ok: boolean
  keys: RedisKeyInfo[]
  cursor: string
  complete: boolean
  /** Total keys in the DB, not the number matching the search. */
  total: number | null
  message: string
  notice: string
}

export interface RedisValueCell {
  text: string
  encoding: 'text' | 'hex'
  bytes: number
  truncated: boolean
}

export interface RedisValueRow {
  id: string
  cells: RedisValueCell[]
}

export interface RedisKeyData {
  ok: boolean
  key: RedisKeyInfo | null
  columns: string[]
  rows: RedisValueRow[]
  value: RedisValueCell | null
  total: number | null
  /** null means complete; SCAN cursors, list offsets, or stream IDs otherwise. */
  nextCursor: string | null
  message: string
  notice: string
}


/* ------------------------------------------------------------------ *
 * Saved Nacos consoles *
 * ------------------------------------------------------------------ */

/**
 * One saved Nacos console.
 *
 * Shaped after MysqlConnection on purpose: same machine-scoped list, same id-keyed tabs,
 * same "the row is the connection" reading. What it does NOT carry is credentials — a
 * Nacos console signs in on its OWN login page, and those cookies live in the view
 * partition, so there is nothing here to store or encrypt.
 */
export interface NacosConnection {
  /** Stable row id. */
  id: string
  /** Which machine this console belongs to. */
  scope: 'local' | 'ssh'
  /** The saved host id when scope is ssh; the local machine id otherwise. */
  hostId: string
  /** What the user calls this console; shown on its tab. */
  name: string
  /** Full console address, scheme included. */
  url: string
  /**
   * Nacos namespace id the console should open, empty for the public one.
   *
   * Kept as a plain string rather than a lookup: the app never calls the Nacos API, so it
   * cannot enumerate namespaces — and it should not, because that would need credentials.
   * The console itself offers the picker once it is signed in.
   */
  namespace: string
  /** Epoch milliseconds of the last save. */
  updatedAt: number
}

/** What the console form submits. id is empty for a console that was never saved. */
export interface NacosConnectionDraft {
  id: string
  name: string
  url: string
  namespace: string
}

/** Every saved Nacos console for one machine, plus whose machine it is. */
export interface NacosConnectionsState {
  /** Display name of the machine these belong to, for the dialog header. */
  machineLabel: string
  connections: NacosConnection[]
}

/** Result of saving one console: the row written, and the machine list afterwards. */
export interface NacosSaveResult extends NacosConnectionsState {
  /** Id of the row that was written. A new console gets its id here. */
  id: string
}

/* ------------------------------------------------------------------ *
 * Renderer API surface
 * ------------------------------------------------------------------ */

/**
 * The API surface exposed on `window.api` by the preload script.
 * This is the single source of truth: the preload implements it and the
 * renderer consumes it, so the two can never drift apart.
 */
export interface AppApi {
  listReleaseNotes(request?: ReleaseNotesPageRequest): Promise<ReleaseNotesResult<ReleaseNotesPage>>
  getReleaseNote(request: ReleaseNoteRequest): Promise<ReleaseNotesResult<ReleaseNoteDetail>>
  markReleaseNoteRead(request: ReleaseNoteRequest): Promise<ReleaseNotesResult<ReleaseNoteRead>>
  onReleaseNotesChanged(listener: () => void): () => void
  invokeToolbox(request: ToolboxInvocation): Promise<unknown>
  getAppInfo(): Promise<AppInfo>
  /** Check the local desktop's GitHub CLI installation and active github.com account. */
  getGithubCliState(): Promise<GithubCliState>
  openGithubCliInstall(): Promise<void>
  logoutGithubCli(account: string): Promise<GithubLogoutResult>
  requestGithubLogin(owner: FocusOwner): Promise<GithubLoginTaskResult>
  getGithubRepositoryPage(request: GithubRepositoryRequest): Promise<GithubRepositoryPage>
  cloneGithubRepository(request: GithubCloneRequest): Promise<GithubCloneResult>
  onGithubCloneProgress(listener: (event: GithubCloneProgressEvent) => void): () => void
  /** Read only the requested part of the repository; omitted mode reads all. */
  getGitLog(cwd: string, mode?: GitReadMode): Promise<GitLogResult>
  /** Read the unified diff of one changed path. */
  getGitDiff(cwd: string, path: string): Promise<GitFileDiff>
  /** Sessions currently owned by the outer manager. */
  listManagedSessions(): Promise<ManagedSessionSummary[]>
  /**
   * Create a managed session.
   *
   * A session is created for a PURPOSE — this machine, or a host over SSH — and the model it
   * talks to is chosen inside the chat (see `switchSessionPlatform`). So the platform is not a
   * parameter: every new session starts on the default and the user switches from there.
   * Omitting projectId always creates an unassigned chat; local project chats inherit
   * that project's directory at creation, independently of later directory changes.
   */
  createManagedSession(kind: 'local' | 'ssh', projectId?: string | null): Promise<ManagedSessionSummary | null>
  listWorkspaceProjects(): Promise<WorkspaceProject[]>
  saveWorkspaceProject(draft: WorkspaceProjectDraft): Promise<WorkspaceProject>
  removeWorkspaceProject(id: string): Promise<boolean>
  moveManagedSession(id: string, projectId: string | null): Promise<boolean>
  onWorkspaceProjectsChanged(listener: (items: WorkspaceProject[]) => void): () => void
  openManagedSession(id: string): Promise<boolean>
  renameManagedSession(id: string, title: string): Promise<boolean>
  destroyManagedSession(id: string): Promise<boolean>
  /**
   * Show a different chat platform inside the CURRENT session.
   *
   * Both platforms' views stay alive, so this preserves the SSH connection, the terminal
   * scrollback and each side's conversation. What it does NOT do is move a conversation from
   * one site to the other — the sites have separate accounts and separate history, so each
   * keeps its own and switching is a change of which one is in front.
   */
  switchSessionPlatform(platformId: string): Promise<boolean>
  /** Pop a native menu of the chat platforms; resolves to the chosen id, or null when dismissed. */
  showModelMenu(currentId: string, anchor?: { x: number; y: number }): Promise<string | null>
  onManagedSessionsChanged(listener: (items: ManagedSessionSummary[]) => void): () => void
  getWorkspaceState(): Promise<WorkspaceState>
  /** Create/activate a normal managed workspace bound to the selected device. */
  showWeb2termConnection(options?: Web2termWorkspaceOptions): Promise<boolean>
  showWorkspaceManager(): Promise<boolean>
  setWorkspaceSshDialogOpen(open: boolean): void
  onWorkspaceChanged(listener: (state: WorkspaceState) => void): () => void
  /** Upload and download tasks across every managed SSH session. */
  getSshTransfers(): Promise<SshTransferTask[]>
  /** Cancel one global transfer by owning session, direction and task id. */
  cancelSshTransfer(sessionId: string, direction: SshTransferDirection, id: string): Promise<boolean>
  onSshTransfersChanged(listener: (items: SshTransferTask[]) => void): () => void
  /** Position the native embedded view under the renderer's placeholder. */
  setEmbedBounds(bounds: EmbedBounds): void
  /** Hide/show the native view (needed while a modal covers it). */
  setEmbedVisible(visible: boolean): void
  /** A still picture of the chat page, taken as a dialog hides it. */
  onEmbedSnapshot(listener: (dataUrl: string) => void): () => void
  sendEmbedCommand(command: EmbedCommand): void
  navigateEmbed(url: string): void
  /** Current embed snapshot; call once on mount to cover events fired before subscribing. */
  getEmbedState(): Promise<EmbedState>
  getFocusChat(owner: FocusOwner): Promise<FocusChatState | null>
  pollFocusChat(owner: FocusOwner, cursor?: FocusHistoryCursor): Promise<FocusChatUpdate | null>
  readFocusExecutionOutput(owner: FocusOwner, messageId: string): Promise<string | null>
  sendFocusMessage(request: FocusSendRequest): Promise<FocusSendOutcome>
  retryFocusSend(owner: FocusOwner, failureId: string): Promise<FocusSendOutcome>
  editFocusMessage(request: FocusEditRequest): Promise<FocusSendOutcome>
  actOnFocusUi(request: FocusUiRequest): Promise<FocusSendOutcome>
  setFocusComposerMode(request: FocusComposerModeRequest): Promise<FocusSendOutcome>
  updateFocusModelSettings(request: FocusModelSettingsRequest): Promise<FocusModelSettingsResult>
  /** Ask about a focus-view selection in the side chat; '' once it is open, otherwise the message to show. */
  askFocusSelection(request: FocusSelectionRequest): Promise<string>
  /** Subscribe to embed state; returns an unsubscribe function. */
  onEmbedState(listener: (state: EmbedState) => void): () => void
  getQuestionChatState(sessionId: string): Promise<QuestionChatState | null>
  createQuestionChat(sessionId: string, platformId: string): Promise<QuestionChatState | null>
  onQuestionChatState(listener: (state: QuestionChatState | null, sessionId: string) => void): () => void
  setQuestionChatViewport(sessionId: string, chatId: string, bounds: EmbedBounds, visible: boolean): void
  questionChatAction(sessionId: string, chatId: string, action: QuestionChatAction): void
  /**
   * Point the embedded view at the email/OTP sign-in page.
   *
   * The only route that can sign in inside the embed: provider OAuth is refused by
   * the provider, and the system browser cannot hand its session back.
   */
  loginWithEmail(): void
  /**
   * Write a session cookie copied out of a normal browser into the embed's
   * partition, then reload and report whether the page is signed in.
   *
   * The escape hatch for accounts that cannot sign in any other way: a ChatGPT
   * account created with Google has no password, and Google refuses embedded
   * sign-in — so the only credential that can be moved into this app is the
   * session token the browser already holds.
   */
  importSession(platformId: string, draft: SessionImportDraft): Promise<SessionImportResult>
  /**
   * Report what a paste WOULD import, without writing anything.
   *
   * The user should not have to guess whether they copied the right row out of DevTools.
   * Side-effect free, so the dialog can call it as they type.
   */
  previewSessionImport(draft: SessionImportDraft): Promise<SessionImportResult>
  /**
   * Import a whole pasted cookie set into ONE PLATFORM's partition.
   *
   * `platformId`, not "the current session", because the login state is global: a partition is
   * per PLATFORM and every session of that platform shares it. Routing this through the active
   * session made the target depend on which tab happened to be in front, which is not a fact
   * about the login at all.
   *
   * `raw` is whatever came out of DevTools — a bare `name=value; …` line, a whole `cookie:`
   * header line, or "Copy as cURL". The parser accepts all three, because asking the user to
   * reformat is asking for a failed import.
   *
   * The value is held in memory for the length of one call and never logged or echoed back.
   */
  importCookieSet(platformId: string, raw: string): Promise<SessionImportResult>
  /** Whether the embedded page is signed in (cookie names only, never values). */
  getEmbedAuthState(): Promise<EmbedAuthState>
  /** Open ChatGPT in the user's normal browser. */
  openChatgptExternal(): void

  /** All stored conversations, newest first. */
  listConversations(): Promise<Conversation[]>
  /** Clean user/assistant transcript for one conversation, oldest first. */
  listConversationMessages(conversationId: string): Promise<ConversationMessage[]>
  /** Read one persisted attachment as a data URL for renderer display. */
  readConversationAttachment(attachmentId: string): Promise<string | null>
  /** Scrape the page's sidebar and merge it into the database. */
  syncConversations(): Promise<Conversation[]>
  removeConversation(id: string): Promise<Conversation[]>
  /** Move a conversation into another project folder on the current machine. */
  moveConversation(id: string, projectId: string): Promise<Conversation[]>
  /** Fires whenever the stored set changes (auto-saved or synced). */
  onConversationsChanged(listener: (items: Conversation[]) => void): () => void

  /** Terminal-mode send interceptor. */
  getInterceptorStatus(): Promise<InterceptorStatus>
  setInterceptorEnabled(enabled: boolean): Promise<InterceptorStatus>
  /** Save prompt injection for the current workspace session only. */
  setPromptInjectionEnabled(enabled: boolean): Promise<InterceptorStatus>
  /** Send the user's collected answers without re-injecting the prompt. */
  answerQuestion(messageId: string, answer: string, owner?: import('./task-clarification').TaskQuestionRequest): Promise<InterceptorStatus>
  /** Dismiss the current question locally, preserving the task and sending no message. */
  cancelQuestion(messageId: string, owner?: import('./task-clarification').TaskQuestionRequest): Promise<InterceptorStatus>
  /** Stop the current model/terminal loop and mark the task as manually ended. */
  endTask(): Promise<InterceptorStatus>
  retryCommandRecovery(owner: FocusOwner, token: number): Promise<string>
  onInterceptorEvent(listener: (status: InterceptorStatus) => void): () => void

  /** Persisted app settings, including the web2term backend address. */
  getSettings(): Promise<AppSettings>
  updateSettings(patch: AppSettingsPatch): Promise<AppSettings>
  getQqMailSettings(): Promise<QqMailSettings>
  saveQqMailSettings(draft: QqMailSettingsDraft): Promise<QqMailResult>
  clearQqMailSettings(): Promise<QqMailResult>
  verifyQqMailSettings(draft: QqMailSettingsDraft): Promise<QqMailResult>
  saveQqMailRecipient(recipientEmail: string): Promise<QqMailResult>
  clearQqMailRecipient(): Promise<QqMailResult>
  getComputerUseCapability(): Promise<ComputerUseCapability>
  onComputerUseCapabilityChanged(listener: (capability: ComputerUseCapability) => void): () => void
  getConversationTools(owner: ConversationToolsOwner): Promise<ConversationToolsState>
  updateConversationTools(request: ConversationToolsUpdate): Promise<ConversationToolsState>
  onConversationToolsChanged(listener: (state: ConversationToolsState) => void): () => void
  getEmergencyStop(): Promise<EmergencyStopState>
  triggerEmergencyStop(): Promise<EmergencyStopState>
  resetEmergencyStop(): Promise<EmergencyStopResetResult>
  onEmergencyStopChanged(listener: (state: EmergencyStopState) => void): () => void
  /** A physical input interrupted a desktop step without yet pausing the task (strike of limit). */
  onDesktopInputWarning(listener: (warning: DesktopInputWarning) => void): () => void
  getAutonomousTask(): Promise<AutonomousTaskState | null>
  getTaskActivity(request: TaskLease): Promise<TaskActivity | null>
  getTaskObservationImage(request: TaskObservationRequest): Promise<string | null>
  revealTaskArtifact(request: TaskArtifactRequest): Promise<string>
  resumeAutonomousTask(request: TaskResumeRequest): Promise<string>
  reopenTaskQuestion(request: import('./task-clarification').TaskQuestionRequest): Promise<string>
  onAutonomousTaskChanged(listener: (state: AutonomousTaskState) => void): () => void
  getBackendAuthState(): Promise<BackendAuthState>
  sendBackendLoginCode(draft: BackendLoginCodeDraft): Promise<BackendAuthResult<{ resendAfterSeconds: number }>>
  loginBackend(draft: BackendLoginDraft): Promise<BackendAuthResult<BackendAuthState>>
  getWeb2termConnection(): Promise<Web2termConnectionState>
  listWeb2termDevices(): Promise<BackendAuthResult<Web2termDevice[]>>
  renameWeb2termDevice(draft: Web2termDeviceRenameDraft): Promise<BackendAuthResult<Web2termDeviceRenameDraft>>
  connectWeb2term(draft: Web2termConnectDraft): Promise<Web2termConnectionState>
  disconnectWeb2term(): Promise<Web2termConnectionState>
  closeWeb2termConnection(): Promise<Web2termConnectionState>
  onWeb2termConnectionChanged(listener: (state: Web2termConnectionState) => void): () => void
  getWeb2termTerminals(): Promise<Web2termTerminalsState>
  getWeb2termTerminalBuffer(sessionId: string): Promise<Web2termTerminalBuffer | null>
  openWeb2termTerminal(size: Web2termTerminalSize): Promise<Web2termTerminalResult>
  closeWeb2termTerminal(sessionId: string): Promise<Web2termTerminalResult>
  sendWeb2termTerminalInput(sessionId: string, data: Uint8Array): Promise<Web2termTerminalResult>
  resizeWeb2termTerminal(sessionId: string, size: Web2termTerminalSize): Promise<Web2termTerminalResult>
  onWeb2termTerminalsChanged(listener: (state: Web2termTerminalsState) => void): () => void
  onWeb2termTerminalOutput(listener: (output: Web2termTerminalOutput) => void): () => void

  /** What the startup probe found out about this machine. */
  getEnvironment(): Promise<EnvironmentInfo>
  /**
   * Fires whenever the description of the machine in charge changes — the probe
   * finishing at startup, the terminal moving, or an SSH session taking over.
   */
  onEnvironmentChanged(listener: (info: EnvironmentInfo) => void): () => void

  /** Terminal-mode automation (execution mode + pause). */
  getAutomationState(): Promise<AutomationState>
  setAutomationMode(mode: ExecutionMode): Promise<AutomationState>
  setAutomationPaused(paused: boolean): Promise<AutomationState>
  /** The three most recent complete command JSON payloads for the current conversation. */
  listRecentCommandJson(conversationId: string): Promise<RecentCommandJson[]>
  /** Start a selected history command in the current terminal and automatically return its result to AI. */
  runRecentCommand(conversationId: string, messageId: string): Promise<RecentCommandRunResult>
  /** Re-scan the last reply right now, ignoring the "already seen" guard. */
  checkLastReply(): Promise<AutomationState>
  onAutomationChanged(listener: (state: AutomationState) => void): () => void

  /** Command executions for a conversation, oldest first. */
  listExecutions(conversationId: string): Promise<ExecutionRecord[]>
  /** Run a command that is waiting (blocked or pending). */
  runExecution(messageId: string): Promise<ExecutionRecord[]>
  /** Mark a waiting command as skipped. */
  skipExecution(messageId: string): Promise<ExecutionRecord[]>
  onExecutionChanged(listener: (records: ExecutionRecord[]) => void): () => void

  /** The terminal belonging to the current conversation. */
  getTerminalState(): Promise<TerminalState>
  /** Type a command straight into the conversation's shell. */
  sendTerminalInput(text: string): Promise<TerminalState>
  /** Stop the command currently running in the execution shell. */
  interruptTerminal(): Promise<TerminalState>
  /** Kill the shell and start a fresh one. */
  resetTerminal(): Promise<TerminalState>
  /** Close the current workspace's web2term PTY, retaining its transcript and binding. */
  closeCurrentWeb2termTerminal(): Promise<TerminalState>
  /**
   * Move the terminal to another directory.
   *
   * Changing where the terminal lives changes the environment the model is told
   * about, so the probe is re-run and the prompt rebuilt.
   */
  setTerminalCwd(path: string): Promise<TerminalState>
  /**
   * How long to wait after a model-driven command finishes before its output goes
   * back to the model. Clamped to 0..600 seconds; 0 disables the wait.
   */
  setTerminalSendDelay(seconds: number): Promise<TerminalState>
  /**
   * Show a native directory picker and return the chosen absolute path.
   *
   * Returns null when the user cancels. The terminal directory is left
   * untouched - the caller decides whether to apply the choice.
   */
  selectDirectory(): Promise<string | null>
  onTerminalChanged(listener: (state: TerminalState) => void): () => void
  getLinuxAgentDownload(): Promise<LinuxAgentDownloadState>
  /** Asks where to save, then starts the download; resolves with the state after the choice. */
  downloadLinuxAgent(): Promise<LinuxAgentDownloadState>
  revealLinuxAgentDownload(): Promise<void>
  onLinuxAgentDownloadChanged(listener: (state: LinuxAgentDownloadState) => void): () => void
  getExtraTerminals(): Promise<ExtraTerminalsState>
  createExtraTerminal(): Promise<{ state: ExtraTerminalsState; id: string } | null>
  sendExtraTerminalInput(id: string, text: string): Promise<void>
  setExtraTerminalCwd(id: string, path: string): Promise<void>
  interruptExtraTerminal(id: string): Promise<void>
  closeExtraTerminal(id: string): Promise<ExtraTerminalsState>
  onExtraTerminalsChanged(listener: (state: ExtraTerminalsState) => void): () => void
  getBackgroundTasks(sessionId: string): Promise<BackgroundTasksState>
  getScheduledTasks(sessionId: string): Promise<ScheduledTasksState>
  saveScheduledTask(draft: ScheduledTaskDraft): Promise<ScheduledTasksState>
  actOnScheduledTask(sessionId: string, id: string, action: ScheduledTaskAction, runId?: string): Promise<ScheduledTasksState>
  onScheduledTasksChanged(listener: (state: ScheduledTasksState, sessionId: string) => void): () => void
  stopBackgroundTask(sessionId: string, taskId: string): Promise<BackgroundTaskStopResult>
  onBackgroundTasksChanged(listener: (state: BackgroundTasksState, sessionId: string) => void): () => void

  /**
   * The note attached to whichever machine the terminal is driving right now.
   *
   * Resolved in the main process against the live backend, so the renderer never
   * has to work out which machine is in charge — the same value the prompt is
   * built from.
   */
  getTerminalNotes(): Promise<TerminalNotes>
  setTerminalNotes(text: string, owner: TerminalNotesOwner): Promise<TerminalNotes>
  onTerminalNotesChanged(listener: (notes: TerminalNotes) => void): () => void

  /** Every saved MySQL connection for whichever machine the terminal is driving. */
  listMysqlConnections(): Promise<MysqlConnectionsState>
  /** Insert or update one connection and return the row id that was written. */
  saveMysqlConnection(draft: MysqlConnectionDraft): Promise<MysqlSaveResult>
  /** Delete one connection by id. */
  removeMysqlConnection(id: string): Promise<MysqlConnectionsState>
  /** Ask one connection which databases it can see. Does not save anything. */
  listMysqlDatabases(draft: MysqlConnectionDraft): Promise<MysqlDatabaseList>
  /** List the tables and views inside one database. */
  listMysqlTables(draft: MysqlConnectionDraft, database: string): Promise<MysqlTableList>
  /** Read a page of rows from one table. */
  queryMysqlTable(draft: MysqlConnectionDraft, database: string, table: string): Promise<MysqlTableData>
  /** Delete exactly one record by its complete primary key. */
  deleteMysqlTableRow(draft: MysqlConnectionDraft, database: string, table: string, key: MysqlRowKey): Promise<MysqlRowDeleteResult>
  /** Set one column of the record with this complete primary key; null writes SQL NULL. */
  updateMysqlTableCell(draft: MysqlConnectionDraft, database: string, table: string, key: MysqlRowKey, column: string, value: string | null): Promise<MysqlCellUpdateResult>
  /** Execute SQL from a table tab. */
  executeMysqlSql(draft: MysqlConnectionDraft, database: string, sql: string): Promise<MysqlSqlExecutionResult>
  /** Execute one CREATE TABLE statement. */
  createMysqlTable(draft: MysqlConnectionDraft, database: string, sql: string): Promise<{ ok: boolean; message: string }>
  /** Drop one table, or one view when type is VIEW. Irreversible. */
  dropMysqlTable(draft: MysqlConnectionDraft, database: string, table: string, type: string): Promise<{ ok: boolean; message: string }>
  /** Read the CREATE statement without changing the database. */
  getMysqlTableDdl(draft: MysqlConnectionDraft, database: string, table: string): Promise<MysqlTableDdl>
  /** Save all base-table CREATE statements to one local SQL file. */
  exportMysqlDatabaseDdl(draft: MysqlConnectionDraft, database: string): Promise<MysqlDdlExportResult>
  onMysqlConnectionChanged(listener: (state: MysqlConnectionsState) => void, sessionId?: string): () => void

  listRedisConnections(): Promise<RedisConnectionsState>
  saveRedisConnection(draft: RedisConnectionDraft): Promise<RedisSaveResult>
  removeRedisConnection(id: string): Promise<RedisConnectionsState>
  onRedisConnectionChanged(listener: (state: RedisConnectionsState) => void, sessionId?: string): () => void
  testRedisConnection(draft: RedisConnectionDraft): Promise<RedisConnectionResult>
  scanRedisKeys(draft: RedisConnectionDraft, cursor: string, search: string): Promise<RedisKeyPage>
  readRedisKey(draft: RedisConnectionDraft, keyId: string, cursor: string): Promise<RedisKeyData>

  /**
   * Nacos console: the server's own web UI, shown inside the app.
   *
   * A native view like the chat embed, so the rectangle is measured by the renderer and
   * reported with setNacosBounds; the URL is whatever the user typed (their Nacos address).
   */
  listNacosConnections(): Promise<NacosConnectionsState>
  saveNacosConnection(draft: NacosConnectionDraft): Promise<NacosSaveResult>
  removeNacosConnection(id: string): Promise<NacosConnectionsState>
  onNacosConnectionChanged(listener: (state: NacosConnectionsState) => void, sessionId?: string): () => void
  openNacosView(url: string): Promise<NacosViewState>
  navigateNacos(url: string): Promise<NacosViewState>
  sendNacosCommand(command: EmbedCommand, sessionId?: string): void
  closeNacosView(): Promise<NacosViewState>
  setNacosBounds(bounds: EmbedBounds, sessionId?: string): void
  setNacosVisible(visible: boolean, sessionId?: string): void
  getNacosState(): Promise<NacosViewState>
  onNacosState(listener: (state: NacosViewState) => void, sessionId?: string): () => void

  /** Saved SSH targets, newest first. */
  listSshHosts(): Promise<SshHost[]>
  /** Connect (saving or updating the host first). */
  connectSsh(draft: SshHostDraft): Promise<SshState>
  disconnectSsh(): Promise<SshState>
  /** Close the SSH transcript and go back to the local terminal. */
  dismissSsh(): Promise<SshState>
  removeSshHost(id: string): Promise<SshHost[]>
  getSshState(): Promise<SshState>
  /** Type a line into the remote shell. */
  sendSshInput(text: string): Promise<SshState>
  /** Pick local files and upload them to the current remote working directory. */
  uploadSshFiles(): Promise<SshState>
  /** Current and recently finished uploads for this SSH session. */
  getSshUploads(): Promise<SshUploadTask[]>
  /** Cancel one in-progress upload. */
  cancelSshUpload(id: string): Promise<boolean>
  onSshUploadsChanged(listener: (items: SshUploadTask[]) => void): () => void
  /** List one remote directory over SFTP. */
  listSshFiles(path: string): Promise<SshFileEntry[]>
  /** Append one SSH directory-picker diagnostic line to the local debug log. */
  logSshCwdDebug(message: string): void
  /** Pick a local destination and start downloading one remote file over SFTP. */
  downloadSshFile(path: string, expectedHostId?: string): Promise<boolean>
  /** Read one PDF from the selected host into memory for the app's viewer. */
  previewSshPdf(request: SshPdfPreviewRequest): Promise<SshPdfPreviewData>
  cancelSshPdfPreview(requestId: string): Promise<void>
  /** Current and recently finished downloads for this SSH session. */
  getSshDownloads(): Promise<SshDownloadTask[]>
  /** Cancel one in-progress download. */
  cancelSshDownload(id: string): Promise<boolean>
  onSshDownloadsChanged(listener: (items: SshDownloadTask[]) => void): () => void
  onSshChanged(listener: (state: SshState) => void): () => void
  /** Current application-updater state. */
  getUpdateStatus(): Promise<UpdateStatus>
  /** Ask GitHub whether a newer release exists. */
  checkForUpdates(): Promise<UpdateStatus>
  /** Start downloading the offered update. */
  downloadUpdate(): Promise<UpdateStatus>
  /** Quit and install an already-downloaded update. */
  installUpdate(): Promise<void>
  /** Fires on every updater phase/progress change. */
  onUpdateChanged(listener: (status: UpdateStatus) => void): () => void
  /** Ask where to save, then zip the last few days of diagnostic logs there. */
  exportDiagnosticLogs(): Promise<DiagnosticLogsExportResult>
}

/** One cancellable PDF read bound to its original SSH host. */
export interface SshPdfPreviewRequest {
  requestId: string
  hostId: string
  path: string
}

export interface SshPdfPreviewData {
  hostId: string
  path: string
  data: ArrayBuffer
}

/** Author of a Git commit. */
export interface GitAuthor {
  name?: string
  email?: string
}

/** One commit in the log, shaped for the log table. */
export interface GitLogEntry {
  hash: string
  branch: string
  parents: string[]
  message: string
  author?: GitAuthor
  committerDate: string
  authorDate?: string
}

/** Counts of changed files in the working tree and index. */
export interface GitIndexStatus {
  modified: number
  added: number
  deleted: number
}

/** How a path changed, used to pick the badge colour in the file list. */
export type GitChangeKind = 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked'

/** One changed path, with the line counts the file list shows. */
export interface GitFileChange {
  path: string
  /** Previous path, only set for renames. */
  oldPath?: string
  kind: GitChangeKind
  /** Single-letter status as Git reports it, for the badge. */
  code: string
  additions: number
  deletions: number
  /** False until line counts are available; untracked files are read on selection. */
  statsLoaded?: boolean
}

/** One line of a unified diff. */
export interface GitDiffLine {
  kind: 'context' | 'add' | 'del'
  oldNumber?: number
  newNumber?: number
  text: string
}

/** One @@ hunk of a unified diff. */
export interface GitDiffHunk {
  header: string
  lines: GitDiffLine[]
}

/** The diff of a single changed path. */
export interface GitFileDiff {
  path: string
  /** True when Git refuses to render a text diff for this path. */
  binary: boolean
  hunks: GitDiffHunk[]
  additions: number
  deletions: number
  /** Raw `@@` hunks, fed straight to the diff viewer. */
  rawHunks: string[]
  /** File contents before the change; empty for a new file. */
  oldContent: string
  /** File contents as they are on disk now. */
  newContent: string
  /** Language hint for the highlighter. */
  lang: string
}

/** Result of inspecting the repository that contains a directory. */
export type GitReadMode = 'all' | 'files' | 'history' | 'stats'

export interface GitFileStat {
  path: string
  additions: number
  deletions: number
}

export interface GitLogResult {
  isRepo: boolean
  currentBranch: string
  entries: GitLogEntry[]
  indexStatus: GitIndexStatus
  files: GitFileChange[]
  /** A failed status read must not appear as a clean work tree. */
  statusLoaded?: boolean
  /** Present only when the requested numstat read succeeded. */
  fileStats?: GitFileStat[]
  error?: string
}


