import type { DesktopInputWarning, EmergencyStopState, EmergencyStopResetResult } from '../shared/emergency-stop'
import type { ToolboxInvocation } from '../shared/toolbox'
import type { ComputerUseCapability } from '../shared/computer-use'
import type { ConversationToolsOwner, ConversationToolsState, ConversationToolsUpdate } from '../shared/conversation-tools'
import type { ScheduledTasksState, ScheduledTaskDraft, ScheduledTaskAction } from '../shared/scheduled-tasks'
import type { AutonomousTaskState, TaskResumeRequest } from '../shared/autonomous-task'
import type { TaskLease } from '../shared/autonomous-task'
import type { TaskActivity, TaskObservationRequest, TaskArtifactRequest } from '../shared/task-presentation'
import type { BackgroundTasksState, BackgroundTaskStopResult } from '../shared/background-tasks'
import type { GithubCliState, GithubCloneProgressEvent, GithubCloneRequest, GithubCloneResult, GithubLoginTaskResult, GithubLogoutResult, GithubRepositoryPage, GithubRepositoryRequest } from '../shared/github'
import type { FocusOwner, FocusChatState, FocusSelectionRequest, FocusSendRequest, FocusEditRequest, FocusSendOutcome, FocusModelSettingsResult } from '../shared/focus-chat'
import type { FocusUiRequest } from '../shared/focus-smart-ui'
import { contextBridge, ipcRenderer } from 'electron'
import type { IpcRendererEvent } from 'electron'
import { IpcChannels } from '../shared/types'
import type { QuestionChatAction, QuestionChatState } from '../shared/deepseek-question'
import type {
  AppApi,
  AppInfo,
  AppSettings,
  AppSettingsPatch,
  BackendAuthResult,
  BackendAuthState,
  BackendLoginCodeDraft,
  BackendLoginDraft,
  Web2termConnectionState,
  Web2termConnectDraft,
  Web2termDevice,
  Web2termDeviceRenameDraft,
  Web2termTerminalsState,
  Web2termTerminalBuffer,
  Web2termTerminalSize,
  Web2termTerminalResult,
  Web2termTerminalOutput,
  AutomationState,
  Conversation,
  ConversationMessage,
  EmbedAuthState,
  EmbedBounds,
  EmbedCommand,
  EmbedState,
  EnvironmentInfo,
  ExecutionMode,
  ExecutionRecord,
  RecentCommandJson,
  RecentCommandRunResult,
  InterceptorStatus,
  GitFileDiff,
  GitLogResult,
  GitReadMode,
  ManagedSessionSummary,
  WorkspaceProject,
  WorkspaceProjectDraft,
  Web2termWorkspaceOptions,

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
  WorkspaceState,
  SessionImportDraft,
  SessionImportResult,
  SshHost,
  SshHostDraft,
  SshFileEntry,
  SshDownloadTask,
  SshUploadTask,
  SshTransferDirection,
  SshTransferTask,
  SshState,
  SshPdfPreviewRequest,
  SshPdfPreviewData,
  TerminalNotes,
  TerminalState,
  ExtraTerminalsState,
  LinuxAgentDownloadState,
  UpdateStatus,
  NacosConnectionDraft,
  NacosConnectionsState,
  NacosSaveResult,
  NacosViewState
} from '../shared/types'

/**
 * The bridge exposed to the renderer. It is typed as `AppApi`, so removing or
 * changing a signature here fails the typecheck instead of breaking the UI.
 */
const api: AppApi = {
  getAppInfo: (): Promise<AppInfo> => ipcRenderer.invoke(IpcChannels.getAppInfo),
  getGithubCliState: (): Promise<GithubCliState> => ipcRenderer.invoke(IpcChannels.githubCliGetState),
  openGithubCliInstall: (): Promise<void> => ipcRenderer.invoke(IpcChannels.githubCliOpenInstall),
  logoutGithubCli: (account: string): Promise<GithubLogoutResult> => ipcRenderer.invoke(IpcChannels.githubCliLogout, account),
  requestGithubLogin: (owner: FocusOwner): Promise<GithubLoginTaskResult> => ipcRenderer.invoke(IpcChannels.githubLoginTask, owner),
  getGithubRepositoryPage: (request: GithubRepositoryRequest): Promise<GithubRepositoryPage> => ipcRenderer.invoke(IpcChannels.githubRepositoriesPage, request),
  cloneGithubRepository: (request: GithubCloneRequest): Promise<GithubCloneResult> => ipcRenderer.invoke(IpcChannels.githubRepositoryClone, request),
  onGithubCloneProgress: (listener: (event: GithubCloneProgressEvent) => void): (() => void) => {
    const handler = (_event: IpcRendererEvent, progress: GithubCloneProgressEvent): void => listener(progress)
    ipcRenderer.on(IpcChannels.githubRepositoryCloneProgress, handler)
    return () => ipcRenderer.removeListener(IpcChannels.githubRepositoryCloneProgress, handler)
  },

  invokeToolbox: (request: ToolboxInvocation): Promise<unknown> => ipcRenderer.invoke(IpcChannels.toolboxInvoke, request),

  getGitLog: (cwd: string, mode?: GitReadMode): Promise<GitLogResult> => ipcRenderer.invoke(IpcChannels.gitLog, cwd, mode),
  getGitDiff: (cwd: string, path: string): Promise<GitFileDiff> => ipcRenderer.invoke(IpcChannels.gitDiff, cwd, path),

  listManagedSessions: (): Promise<ManagedSessionSummary[]> =>
    ipcRenderer.invoke(IpcChannels.managerSessionsList),

  createManagedSession: (kind: 'local' | 'ssh', projectId?: string | null): Promise<ManagedSessionSummary | null> =>
    ipcRenderer.invoke(IpcChannels.managerSessionCreate, kind, projectId),

  listWorkspaceProjects: (): Promise<WorkspaceProject[]> => ipcRenderer.invoke(IpcChannels.workspaceProjectsList),
  saveWorkspaceProject: (draft: WorkspaceProjectDraft): Promise<WorkspaceProject> => ipcRenderer.invoke(IpcChannels.workspaceProjectSave, draft),
  removeWorkspaceProject: (id: string): Promise<boolean> => ipcRenderer.invoke(IpcChannels.workspaceProjectRemove, id),
  moveManagedSession: (id: string, projectId: string | null): Promise<boolean> => ipcRenderer.invoke(IpcChannels.managerSessionMove, id, projectId),
  onWorkspaceProjectsChanged: (listener: (items: WorkspaceProject[]) => void): (() => void) => {
    const handler = (_event: IpcRendererEvent, items: WorkspaceProject[]): void => listener(items)
    ipcRenderer.on(IpcChannels.workspaceProjectsChanged, handler)
    return () => ipcRenderer.removeListener(IpcChannels.workspaceProjectsChanged, handler)
  },

  openManagedSession: (id: string): Promise<boolean> =>
    ipcRenderer.invoke(IpcChannels.managerSessionOpen, id),

  renameManagedSession: (id: string, title: string): Promise<boolean> =>
    ipcRenderer.invoke(IpcChannels.managerSessionRename, id, title),

  destroyManagedSession: (id: string): Promise<boolean> =>
    ipcRenderer.invoke(IpcChannels.managerSessionDestroy, id),

  switchSessionPlatform: (platformId: string): Promise<boolean> =>
    ipcRenderer.invoke(IpcChannels.sessionSwitchPlatform, platformId),

  showModelMenu: (currentId: string, anchor?: { x: number; y: number }): Promise<string | null> =>
    ipcRenderer.invoke(IpcChannels.sessionShowModelMenu, currentId, anchor),

  onManagedSessionsChanged: (listener: (items: ManagedSessionSummary[]) => void): (() => void) => {
    const handler = (_event: IpcRendererEvent, items: ManagedSessionSummary[]): void => listener(items)
    ipcRenderer.on(IpcChannels.managerSessionsChanged, handler)
    return () => ipcRenderer.removeListener(IpcChannels.managerSessionsChanged, handler)
  },

  getWorkspaceState: (): Promise<WorkspaceState> => ipcRenderer.invoke(IpcChannels.workspaceGetState),
  showWeb2termConnection: (options?: Web2termWorkspaceOptions): Promise<boolean> => ipcRenderer.invoke(IpcChannels.workspaceShowWeb2term, options),

  showWorkspaceManager: (): Promise<boolean> => ipcRenderer.invoke(IpcChannels.workspaceShowManager),

  setWorkspaceSshDialogOpen: (open: boolean): void => {
    ipcRenderer.send(IpcChannels.workspaceSetOpenSshDialog, open)
  },

  onWorkspaceChanged: (listener: (state: WorkspaceState) => void): (() => void) => {
    const handler = (_event: IpcRendererEvent, state: WorkspaceState): void => listener(state)
    ipcRenderer.on(IpcChannels.workspaceChanged, handler)
    return () => ipcRenderer.removeListener(IpcChannels.workspaceChanged, handler)
  },

  getSshTransfers: (): Promise<SshTransferTask[]> =>
    ipcRenderer.invoke(IpcChannels.sshTransfersGet),

  cancelSshTransfer: (sessionId: string, direction: SshTransferDirection, id: string): Promise<boolean> =>
    ipcRenderer.invoke(IpcChannels.sshTransferCancel, sessionId, direction, id),

  onSshTransfersChanged: (listener: (items: SshTransferTask[]) => void): (() => void) => {
    const handler = (_event: IpcRendererEvent, items: SshTransferTask[]): void => listener(items)
    ipcRenderer.on(IpcChannels.sshTransfersChanged, handler)
    return () => ipcRenderer.removeListener(IpcChannels.sshTransfersChanged, handler)
  },

  setEmbedBounds: (bounds: EmbedBounds): void => {
    ipcRenderer.send(IpcChannels.embedSetBounds, bounds)
  },

  setEmbedVisible: (visible: boolean): void => {
    ipcRenderer.send(IpcChannels.embedSetVisible, visible)
  },

  sendEmbedCommand: (command: EmbedCommand): void => {
    ipcRenderer.send(IpcChannels.embedCommand, command)
  },

  navigateEmbed: (url: string): void => {
    ipcRenderer.send(IpcChannels.embedNavigate, url)
  },

  getEmbedState: (): Promise<EmbedState> => ipcRenderer.invoke(IpcChannels.embedGetState),
  getFocusChat: (owner: FocusOwner): Promise<FocusChatState | null> => ipcRenderer.invoke(IpcChannels.focusChatGet, owner),
  sendFocusMessage: (request: FocusSendRequest): Promise<FocusSendOutcome> => ipcRenderer.invoke(IpcChannels.focusChatSend, request),
  retryFocusSend: (owner, failureId): Promise<FocusSendOutcome> => ipcRenderer.invoke(IpcChannels.focusChatRetrySend, owner, failureId),
  editFocusMessage: (request: FocusEditRequest): Promise<FocusSendOutcome> => ipcRenderer.invoke(IpcChannels.focusChatEdit, request),
  actOnFocusUi: (request: FocusUiRequest): Promise<FocusSendOutcome> => ipcRenderer.invoke(IpcChannels.focusChatUiAction, request),
  setFocusComposerMode: (request): Promise<FocusSendOutcome> => ipcRenderer.invoke(IpcChannels.focusChatComposerMode, request),
  updateFocusModelSettings: (request): Promise<FocusModelSettingsResult> => ipcRenderer.invoke(IpcChannels.focusChatModelSettings, request),
  /** '' once the side chat is open, otherwise the message to show. */
  askFocusSelection: (request: FocusSelectionRequest): Promise<string> => ipcRenderer.invoke(IpcChannels.focusChatAsk, request),

  getQuestionChatState: (sessionId: string): Promise<QuestionChatState | null> => ipcRenderer.invoke(IpcChannels.questionChatGetState, sessionId),
  createQuestionChat: (sessionId: string, platformId: string): Promise<QuestionChatState | null> => ipcRenderer.invoke(IpcChannels.questionChatCreate, sessionId, platformId),
  onQuestionChatState: (listener: (state: QuestionChatState | null, sessionId: string) => void): (() => void) => {
    const handler = (_event: IpcRendererEvent, state: QuestionChatState | null, sessionId: string): void => listener(state, sessionId)
    ipcRenderer.on(IpcChannels.questionChatState, handler)
    return () => ipcRenderer.removeListener(IpcChannels.questionChatState, handler)
  },
  setQuestionChatViewport: (sessionId: string, chatId: string, bounds: EmbedBounds, visible: boolean): void => {
    ipcRenderer.send(IpcChannels.questionChatViewport, sessionId, chatId, bounds, visible)
  },
  questionChatAction: (sessionId: string, chatId: string, action: QuestionChatAction): void => {
    ipcRenderer.send(IpcChannels.questionChatAction, sessionId, chatId, action)
  },

  loginWithEmail: (): void => {
    ipcRenderer.send(IpcChannels.embedLoginWithEmail)
  },

  importSession: (platformId: string, draft: SessionImportDraft): Promise<SessionImportResult> =>
    ipcRenderer.invoke(IpcChannels.embedImportSession, platformId, draft),

  previewSessionImport: (draft: SessionImportDraft): Promise<SessionImportResult> =>
    ipcRenderer.invoke(IpcChannels.embedPreviewSession, draft),

  importCookieSet: (platformId: string, raw: string): Promise<SessionImportResult> =>
    ipcRenderer.invoke(IpcChannels.embedImportCookieSet, platformId, raw),

  getEmbedAuthState: (): Promise<EmbedAuthState> =>
    ipcRenderer.invoke(IpcChannels.embedGetAuthState),

  openChatgptExternal: (): void => {
    ipcRenderer.send(IpcChannels.openChatgptExternal)
  },

  listConversations: (): Promise<Conversation[]> =>
    ipcRenderer.invoke(IpcChannels.conversationsList),

  listConversationMessages: (conversationId: string): Promise<ConversationMessage[]> =>
    ipcRenderer.invoke(IpcChannels.conversationMessagesList, conversationId),

  readConversationAttachment: (attachmentId: string): Promise<string | null> =>
    ipcRenderer.invoke(IpcChannels.conversationAttachmentRead, attachmentId),

  syncConversations: (): Promise<Conversation[]> =>
    ipcRenderer.invoke(IpcChannels.conversationsSync),

removeConversation: (id: string): Promise<Conversation[]> =>
    ipcRenderer.invoke(IpcChannels.conversationsRemove, id),

  moveConversation: (id: string, projectId: string): Promise<Conversation[]> =>
    ipcRenderer.invoke(IpcChannels.conversationsMove, id, projectId),

  onConversationsChanged: (listener: (items: Conversation[]) => void): (() => void) => {
    const handler = (_event: IpcRendererEvent, items: Conversation[]): void => listener(items)
    ipcRenderer.on(IpcChannels.conversationsChanged, handler)
    return () => {
      ipcRenderer.removeListener(IpcChannels.conversationsChanged, handler)
    }
  },

  getInterceptorStatus: (): Promise<InterceptorStatus> =>
    ipcRenderer.invoke(IpcChannels.interceptorGetState),

  setInterceptorEnabled: (enabled: boolean): Promise<InterceptorStatus> =>
    ipcRenderer.invoke(IpcChannels.interceptorSetEnabled, enabled),

  setPromptInjectionEnabled: (enabled: boolean): Promise<InterceptorStatus> =>
    ipcRenderer.invoke(IpcChannels.interceptorSetPromptInjectionEnabled, enabled),

  answerQuestion: (messageId: string, answer: string, owner?: import('../shared/task-clarification').TaskQuestionRequest): Promise<InterceptorStatus> =>
    ipcRenderer.invoke(IpcChannels.interceptorAnswerQuestion, messageId, answer, owner),

  cancelQuestion: (messageId: string, owner?: import('../shared/task-clarification').TaskQuestionRequest): Promise<InterceptorStatus> =>
    ipcRenderer.invoke(IpcChannels.interceptorCancelQuestion, messageId, owner),

  getEmergencyStop: (): Promise<EmergencyStopState> => ipcRenderer.invoke(IpcChannels.emergencyStopGet),
  triggerEmergencyStop: (): Promise<EmergencyStopState> => ipcRenderer.invoke(IpcChannels.emergencyStopTrigger),
  resetEmergencyStop: (): Promise<EmergencyStopResetResult> => ipcRenderer.invoke(IpcChannels.emergencyStopReset),
  onEmergencyStopChanged: (listener: (state: EmergencyStopState) => void) => {
    const handler = (_event: IpcRendererEvent, state: EmergencyStopState): void => listener(state)
    ipcRenderer.on(IpcChannels.emergencyStopChanged, handler)
    return () => ipcRenderer.removeListener(IpcChannels.emergencyStopChanged, handler)
  },
  onDesktopInputWarning: (listener: (warning: DesktopInputWarning) => void) => {
    const handler = (_event: IpcRendererEvent, warning: DesktopInputWarning): void => listener(warning)
    ipcRenderer.on(IpcChannels.desktopInputWarning, handler)
    return () => ipcRenderer.removeListener(IpcChannels.desktopInputWarning, handler)
  },
  endTask: (): Promise<InterceptorStatus> => ipcRenderer.invoke(IpcChannels.interceptorEndTask),
  retryCommandRecovery: (owner: FocusOwner, token: number): Promise<string> => ipcRenderer.invoke(IpcChannels.commandRecoveryRetry, owner, token),

  onInterceptorEvent: (listener: (status: InterceptorStatus) => void): (() => void) => {
    const handler = (_event: IpcRendererEvent, status: InterceptorStatus): void => listener(status)
    ipcRenderer.on(IpcChannels.interceptorEvent, handler)
    return () => {
      ipcRenderer.removeListener(IpcChannels.interceptorEvent, handler)
    }
  },

  getSettings: (): Promise<AppSettings> => ipcRenderer.invoke(IpcChannels.settingsGet),

  updateSettings: (patch: AppSettingsPatch): Promise<AppSettings> =>
    ipcRenderer.invoke(IpcChannels.settingsUpdate, patch),

  getComputerUseCapability: (): Promise<ComputerUseCapability> =>
    ipcRenderer.invoke(IpcChannels.computerUseGetCapability),
  getConversationTools: (owner: ConversationToolsOwner): Promise<ConversationToolsState> =>
    ipcRenderer.invoke(IpcChannels.conversationToolsGet, owner),
  updateConversationTools: (request: ConversationToolsUpdate): Promise<ConversationToolsState> =>
    ipcRenderer.invoke(IpcChannels.conversationToolsUpdate, request),
  onConversationToolsChanged: (listener: (state: ConversationToolsState) => void): (() => void) => {
    const handler = (_event: IpcRendererEvent, state: ConversationToolsState): void => listener(state)
    ipcRenderer.on(IpcChannels.conversationToolsChanged, handler)
    return () => ipcRenderer.removeListener(IpcChannels.conversationToolsChanged, handler)
  },
  onComputerUseCapabilityChanged: (listener: (capability: ComputerUseCapability) => void): (() => void) => {
    const handler = (_event: IpcRendererEvent, capability: ComputerUseCapability): void => listener(capability)
    ipcRenderer.on(IpcChannels.computerUseCapabilityChanged, handler)
    return () => ipcRenderer.removeListener(IpcChannels.computerUseCapabilityChanged, handler)
  },

  getAutonomousTask: (): Promise<AutonomousTaskState | null> => ipcRenderer.invoke(IpcChannels.autonomousTaskGet),
  getTaskActivity: (request: TaskLease): Promise<TaskActivity | null> => ipcRenderer.invoke(IpcChannels.taskActivityGet, request),
  getTaskObservationImage: (request: TaskObservationRequest): Promise<string | null> => ipcRenderer.invoke(IpcChannels.taskObservationImageGet, request),
  revealTaskArtifact: (request: TaskArtifactRequest): Promise<string> => ipcRenderer.invoke(IpcChannels.taskArtifactReveal, request),
  reopenTaskQuestion: (request: import('../shared/task-clarification').TaskQuestionRequest): Promise<string> => ipcRenderer.invoke(IpcChannels.autonomousTaskQuestionReopen, request),
  resumeAutonomousTask: (request: TaskResumeRequest): Promise<string> => ipcRenderer.invoke(IpcChannels.autonomousTaskResume, request),
  onAutonomousTaskChanged: (listener: (state: AutonomousTaskState) => void): (() => void) => {
    const handler = (_event: IpcRendererEvent, state: AutonomousTaskState): void => listener(state)
    ipcRenderer.on(IpcChannels.autonomousTaskChanged, handler)
    return () => ipcRenderer.removeListener(IpcChannels.autonomousTaskChanged, handler)
  },

  getBackendAuthState: (): Promise<BackendAuthState> => ipcRenderer.invoke(IpcChannels.backendAuthGet),
  sendBackendLoginCode: (draft: BackendLoginCodeDraft): Promise<BackendAuthResult<{ resendAfterSeconds: number }>> =>
    ipcRenderer.invoke(IpcChannels.backendLoginCode, draft),
  loginBackend: (draft: BackendLoginDraft): Promise<BackendAuthResult<BackendAuthState>> =>
    ipcRenderer.invoke(IpcChannels.backendLogin, draft),
  getWeb2termConnection: (): Promise<Web2termConnectionState> => ipcRenderer.invoke(IpcChannels.web2termGetState),
  listWeb2termDevices: (): Promise<BackendAuthResult<Web2termDevice[]>> => ipcRenderer.invoke(IpcChannels.web2termListDevices),
  renameWeb2termDevice: (draft: Web2termDeviceRenameDraft): Promise<BackendAuthResult<Web2termDeviceRenameDraft>> => ipcRenderer.invoke(IpcChannels.web2termRenameDevice, draft),
  connectWeb2term: (draft: Web2termConnectDraft): Promise<Web2termConnectionState> => ipcRenderer.invoke(IpcChannels.web2termConnect, draft),
  disconnectWeb2term: (): Promise<Web2termConnectionState> => ipcRenderer.invoke(IpcChannels.web2termDisconnect),
  closeWeb2termConnection: (): Promise<Web2termConnectionState> => ipcRenderer.invoke(IpcChannels.web2termClose),
  onWeb2termConnectionChanged: (listener: (state: Web2termConnectionState) => void): (() => void) => {
    const handler = (_event: IpcRendererEvent, state: Web2termConnectionState): void => listener(state)
    ipcRenderer.on(IpcChannels.web2termChanged, handler)
    return () => ipcRenderer.removeListener(IpcChannels.web2termChanged, handler)
  },
  getWeb2termTerminals: (): Promise<Web2termTerminalsState> => ipcRenderer.invoke(IpcChannels.web2termTerminalsGet),
  getWeb2termTerminalBuffer: (id: string): Promise<Web2termTerminalBuffer | null> => ipcRenderer.invoke(IpcChannels.web2termTerminalBuffer, id),
  openWeb2termTerminal: (size: Web2termTerminalSize): Promise<Web2termTerminalResult> => ipcRenderer.invoke(IpcChannels.web2termTerminalOpen, size),
  closeWeb2termTerminal: (id: string): Promise<Web2termTerminalResult> => ipcRenderer.invoke(IpcChannels.web2termTerminalClose, id),
  sendWeb2termTerminalInput: (id: string, data: Uint8Array): Promise<Web2termTerminalResult> => ipcRenderer.invoke(IpcChannels.web2termTerminalInput, id, data),
  resizeWeb2termTerminal: (id: string, size: Web2termTerminalSize): Promise<Web2termTerminalResult> => ipcRenderer.invoke(IpcChannels.web2termTerminalResize, id, size),
  onWeb2termTerminalsChanged: (listener: (state: Web2termTerminalsState) => void): (() => void) => {
    const handler = (_event: IpcRendererEvent, state: Web2termTerminalsState): void => listener(state)
    ipcRenderer.on(IpcChannels.web2termTerminalsChanged, handler)
    return () => ipcRenderer.removeListener(IpcChannels.web2termTerminalsChanged, handler)
  },
  onWeb2termTerminalOutput: (listener: (output: Web2termTerminalOutput) => void): (() => void) => {
    const handler = (_event: IpcRendererEvent, output: Web2termTerminalOutput): void => listener(output)
    ipcRenderer.on(IpcChannels.web2termTerminalOutput, handler)
    return () => ipcRenderer.removeListener(IpcChannels.web2termTerminalOutput, handler)
  },

  getEnvironment: (): Promise<EnvironmentInfo> => ipcRenderer.invoke(IpcChannels.environmentGet),

  onEnvironmentChanged: (listener: (info: EnvironmentInfo) => void): (() => void) => {
    const handler = (_event: IpcRendererEvent, info: EnvironmentInfo): void => listener(info)
    ipcRenderer.on(IpcChannels.environmentChanged, handler)
    return () => {
      ipcRenderer.removeListener(IpcChannels.environmentChanged, handler)
    }
  },

  listSshHosts: (): Promise<SshHost[]> => ipcRenderer.invoke(IpcChannels.sshListHosts),

  connectSsh: (draft: SshHostDraft): Promise<SshState> =>
    ipcRenderer.invoke(IpcChannels.sshConnect, draft),

  disconnectSsh: (): Promise<SshState> => ipcRenderer.invoke(IpcChannels.sshDisconnect),

  dismissSsh: (): Promise<SshState> => ipcRenderer.invoke(IpcChannels.sshDismiss),

  removeSshHost: (id: string): Promise<SshHost[]> =>
    ipcRenderer.invoke(IpcChannels.sshRemoveHost, id),

  getSshState: (): Promise<SshState> => ipcRenderer.invoke(IpcChannels.sshGetState),

  sendSshInput: (text: string): Promise<SshState> =>
    ipcRenderer.invoke(IpcChannels.sshInput, text),

  uploadSshFiles: (): Promise<SshState> => ipcRenderer.invoke(IpcChannels.sshUploadFiles),

  getSshUploads: (): Promise<SshUploadTask[]> => ipcRenderer.invoke(IpcChannels.sshUploadsGet),

  cancelSshUpload: (id: string): Promise<boolean> => ipcRenderer.invoke(IpcChannels.sshUploadCancel, id),

  onSshUploadsChanged: (listener: (items: SshUploadTask[]) => void): (() => void) => {
    const handler = (_event: IpcRendererEvent, items: SshUploadTask[]): void => listener(items)
    ipcRenderer.on(IpcChannels.sshUploadsChanged, handler)
    return () => ipcRenderer.removeListener(IpcChannels.sshUploadsChanged, handler)
  },

  listSshFiles: (path: string): Promise<SshFileEntry[]> =>
    ipcRenderer.invoke(IpcChannels.sshListFiles, path),

  logSshCwdDebug: (message: string): void => {
    ipcRenderer.send(IpcChannels.sshCwdDebugLog, message)
  },

  previewSshPdf: (request: SshPdfPreviewRequest): Promise<SshPdfPreviewData> =>
    ipcRenderer.invoke(IpcChannels.sshPdfPreview, request),
  cancelSshPdfPreview: (requestId: string): Promise<void> =>
    ipcRenderer.invoke(IpcChannels.sshPdfPreviewCancel, requestId),

  downloadSshFile: (path: string, expectedHostId?: string): Promise<boolean> =>
    ipcRenderer.invoke(IpcChannels.sshDownloadFile, path, expectedHostId),

  getSshDownloads: (): Promise<SshDownloadTask[]> =>
    ipcRenderer.invoke(IpcChannels.sshDownloadsGet),

  cancelSshDownload: (id: string): Promise<boolean> =>
    ipcRenderer.invoke(IpcChannels.sshDownloadCancel, id),

  onSshDownloadsChanged: (listener: (items: SshDownloadTask[]) => void): (() => void) => {
    const handler = (_event: IpcRendererEvent, items: SshDownloadTask[]): void => listener(items)
    ipcRenderer.on(IpcChannels.sshDownloadsChanged, handler)
    return () => ipcRenderer.removeListener(IpcChannels.sshDownloadsChanged, handler)
  },

  onSshChanged: (listener: (state: SshState) => void): (() => void) => {
    const handler = (_event: IpcRendererEvent, state: SshState): void => listener(state)
    ipcRenderer.on(IpcChannels.sshChanged, handler)
    return () => {
      ipcRenderer.removeListener(IpcChannels.sshChanged, handler)
    }
  },

  getAutomationState: (): Promise<AutomationState> =>
    ipcRenderer.invoke(IpcChannels.automationGetState),

  setAutomationMode: (mode: ExecutionMode): Promise<AutomationState> =>
    ipcRenderer.invoke(IpcChannels.automationSetMode, mode),

  setAutomationPaused: (paused: boolean): Promise<AutomationState> =>
    ipcRenderer.invoke(IpcChannels.automationSetPaused, paused),

  listRecentCommandJson: (conversationId: string): Promise<RecentCommandJson[]> =>
    ipcRenderer.invoke(IpcChannels.recentCommandList, conversationId),

  runRecentCommand: (conversationId: string, messageId: string): Promise<RecentCommandRunResult> =>
    ipcRenderer.invoke(IpcChannels.recentCommandRun, conversationId, messageId),
  checkLastReply: (): Promise<AutomationState> =>
    ipcRenderer.invoke(IpcChannels.automationCheckNow),

  onAutomationChanged: (listener: (state: AutomationState) => void): (() => void) => {
    const handler = (_event: IpcRendererEvent, state: AutomationState): void => listener(state)
    ipcRenderer.on(IpcChannels.automationChanged, handler)
    return () => {
      ipcRenderer.removeListener(IpcChannels.automationChanged, handler)
    }
  },

  listExecutions: (conversationId: string): Promise<ExecutionRecord[]> =>
    ipcRenderer.invoke(IpcChannels.executionList, conversationId),

  runExecution: (messageId: string): Promise<ExecutionRecord[]> =>
    ipcRenderer.invoke(IpcChannels.executionRun, messageId),

  skipExecution: (messageId: string): Promise<ExecutionRecord[]> =>
    ipcRenderer.invoke(IpcChannels.executionSkip, messageId),

  onExecutionChanged: (listener: (records: ExecutionRecord[]) => void): (() => void) => {
    const handler = (_event: IpcRendererEvent, records: ExecutionRecord[]): void => listener(records)
    ipcRenderer.on(IpcChannels.executionChanged, handler)
    return () => {
      ipcRenderer.removeListener(IpcChannels.executionChanged, handler)
    }
  },

  getTerminalState: (): Promise<TerminalState> => ipcRenderer.invoke(IpcChannels.terminalGetState),

  sendTerminalInput: (text: string): Promise<TerminalState> =>
    ipcRenderer.invoke(IpcChannels.terminalInput, text),

  interruptTerminal: (): Promise<TerminalState> => ipcRenderer.invoke(IpcChannels.terminalInterrupt),
  resetTerminal: (): Promise<TerminalState> => ipcRenderer.invoke(IpcChannels.terminalReset),
  closeCurrentWeb2termTerminal: (): Promise<TerminalState> => ipcRenderer.invoke(IpcChannels.terminalCloseWeb2term),

  setTerminalCwd: (path: string): Promise<TerminalState> =>
    ipcRenderer.invoke(IpcChannels.terminalSetCwd, path),

  setTerminalSendDelay: (seconds: number): Promise<TerminalState> =>
    ipcRenderer.invoke(IpcChannels.terminalSetSendDelay, seconds),

  getLinuxAgentDownload: (): Promise<LinuxAgentDownloadState> => ipcRenderer.invoke(IpcChannels.linuxAgentDownloadGet),
  downloadLinuxAgent: (): Promise<LinuxAgentDownloadState> => ipcRenderer.invoke(IpcChannels.linuxAgentDownloadStart),
  revealLinuxAgentDownload: (): Promise<void> => ipcRenderer.invoke(IpcChannels.linuxAgentDownloadReveal),
  onLinuxAgentDownloadChanged: (listener: (state: LinuxAgentDownloadState) => void): (() => void) => {
    const handler = (_event: IpcRendererEvent, state: LinuxAgentDownloadState): void => listener(state)
    ipcRenderer.on(IpcChannels.linuxAgentDownloadChanged, handler)
    return () => {
      ipcRenderer.removeListener(IpcChannels.linuxAgentDownloadChanged, handler)
    }
  },
  getExtraTerminals: (): Promise<ExtraTerminalsState> => ipcRenderer.invoke(IpcChannels.extraTerminalsGet),
  getBackgroundTasks: (sessionId: string): Promise<BackgroundTasksState> => ipcRenderer.invoke(IpcChannels.backgroundTasksGet, sessionId),
  getScheduledTasks: (sessionId: string): Promise<ScheduledTasksState> => ipcRenderer.invoke(IpcChannels.scheduledTasksGet, sessionId),
  saveScheduledTask: (draft: ScheduledTaskDraft): Promise<ScheduledTasksState> => ipcRenderer.invoke(IpcChannels.scheduledTaskSave, draft),
  actOnScheduledTask: (sessionId: string, id: string, action: ScheduledTaskAction, runId?: string): Promise<ScheduledTasksState> =>
    ipcRenderer.invoke(IpcChannels.scheduledTaskAction, sessionId, id, action, runId),
  onScheduledTasksChanged: (listener: (state: ScheduledTasksState, sessionId: string) => void): (() => void) => {
    const handler = (_event: IpcRendererEvent, state: ScheduledTasksState, sessionId: string): void => listener(state, sessionId)
    ipcRenderer.on(IpcChannels.scheduledTasksChanged, handler)
    return () => ipcRenderer.removeListener(IpcChannels.scheduledTasksChanged, handler)
  },
  stopBackgroundTask: (sessionId: string, taskId: string): Promise<BackgroundTaskStopResult> => ipcRenderer.invoke(IpcChannels.backgroundTaskStop, sessionId, taskId),
  onBackgroundTasksChanged: (listener: (state: BackgroundTasksState, sessionId: string) => void): (() => void) => {
    const handler = (_event: IpcRendererEvent, state: BackgroundTasksState, sessionId: string): void => listener(state, sessionId)
    ipcRenderer.on(IpcChannels.backgroundTasksChanged, handler)
    return () => ipcRenderer.removeListener(IpcChannels.backgroundTasksChanged, handler)
  },
  createExtraTerminal: (): Promise<{ state: ExtraTerminalsState; id: string } | null> =>
    ipcRenderer.invoke(IpcChannels.extraTerminalCreate),
  sendExtraTerminalInput: (id: string, text: string): Promise<void> =>
    ipcRenderer.invoke(IpcChannels.extraTerminalInput, id, text),
  setExtraTerminalCwd: (id: string, path: string): Promise<void> =>
    ipcRenderer.invoke(IpcChannels.extraTerminalSetCwd, id, path),
  interruptExtraTerminal: (id: string): Promise<void> => ipcRenderer.invoke(IpcChannels.extraTerminalInterrupt, id),
  closeExtraTerminal: (id: string): Promise<ExtraTerminalsState> => ipcRenderer.invoke(IpcChannels.extraTerminalClose, id),
  onExtraTerminalsChanged: (listener: (state: ExtraTerminalsState) => void): (() => void) => {
    const handler = (_event: IpcRendererEvent, state: ExtraTerminalsState): void => listener(state)
    ipcRenderer.on(IpcChannels.extraTerminalsChanged, handler)
    return () => {
      ipcRenderer.removeListener(IpcChannels.extraTerminalsChanged, handler)
    }
  },

  selectDirectory: (): Promise<string | null> =>
    ipcRenderer.invoke(IpcChannels.dialogSelectDirectory),

  onTerminalChanged: (listener: (state: TerminalState) => void): (() => void) => {
    const handler = (_event: IpcRendererEvent, state: TerminalState): void => listener(state)
    ipcRenderer.on(IpcChannels.terminalChanged, handler)
    return () => {
      ipcRenderer.removeListener(IpcChannels.terminalChanged, handler)
    }
  },

  getTerminalNotes: (): Promise<TerminalNotes> =>
    ipcRenderer.invoke(IpcChannels.terminalNotesGet),

  setTerminalNotes: (text, owner): Promise<TerminalNotes> =>
    ipcRenderer.invoke(IpcChannels.terminalNotesSet, text, owner),

  onTerminalNotesChanged: (listener: (notes: TerminalNotes) => void): (() => void) => {
    const handler = (_event: IpcRendererEvent, notes: TerminalNotes): void => listener(notes)
    ipcRenderer.on(IpcChannels.terminalNotesChanged, handler)
    return () => {
      ipcRenderer.removeListener(IpcChannels.terminalNotesChanged, handler)
    }
  },
  listMysqlConnections: (): Promise<MysqlConnectionsState> =>
    ipcRenderer.invoke(IpcChannels.mysqlConnList),

  saveMysqlConnection: (draft: MysqlConnectionDraft): Promise<MysqlSaveResult> =>
    ipcRenderer.invoke(IpcChannels.mysqlConnSave, draft),

  listMysqlTables: (draft: MysqlConnectionDraft, database: string): Promise<MysqlTableList> =>
    ipcRenderer.invoke(IpcChannels.mysqlConnListTables, draft, database),

  queryMysqlTable: (draft: MysqlConnectionDraft, database: string, table: string): Promise<MysqlTableData> =>
    ipcRenderer.invoke(IpcChannels.mysqlConnQueryTable, draft, database, table),

  deleteMysqlTableRow: (draft: MysqlConnectionDraft, database: string, table: string, key: MysqlRowKey): Promise<MysqlRowDeleteResult> =>
    ipcRenderer.invoke(IpcChannels.mysqlConnDeleteRow, draft, database, table, key),

  updateMysqlTableCell: (draft: MysqlConnectionDraft, database: string, table: string, key: MysqlRowKey, column: string, value: string | null): Promise<MysqlCellUpdateResult> =>
    ipcRenderer.invoke(IpcChannels.mysqlConnUpdateCell, draft, database, table, key, column, value),

  executeMysqlSql: (draft: MysqlConnectionDraft, database: string, sql: string): Promise<MysqlSqlExecutionResult> =>
    ipcRenderer.invoke(IpcChannels.mysqlConnExecuteSql, draft, database, sql),

  createMysqlTable: (draft: MysqlConnectionDraft, database: string, sql: string): Promise<{ ok: boolean; message: string }> =>
    ipcRenderer.invoke(IpcChannels.mysqlConnCreateTable, draft, database, sql),

  dropMysqlTable: (draft: MysqlConnectionDraft, database: string, table: string, type: string): Promise<{ ok: boolean; message: string }> =>
    ipcRenderer.invoke(IpcChannels.mysqlConnDropTable, draft, database, table, type),

  getMysqlTableDdl: (draft: MysqlConnectionDraft, database: string, table: string): Promise<MysqlTableDdl> =>
    ipcRenderer.invoke(IpcChannels.mysqlConnTableDdl, draft, database, table),

  exportMysqlDatabaseDdl: (draft: MysqlConnectionDraft, database: string): Promise<MysqlDdlExportResult> =>
    ipcRenderer.invoke(IpcChannels.mysqlConnExportDdl, draft, database),

  listMysqlDatabases: (draft: MysqlConnectionDraft): Promise<MysqlDatabaseList> =>
    ipcRenderer.invoke(IpcChannels.mysqlConnListDatabases, draft),

  removeMysqlConnection: (id: string): Promise<MysqlConnectionsState> =>
    ipcRenderer.invoke(IpcChannels.mysqlConnRemove, id),

  onMysqlConnectionChanged: (listener: (state: MysqlConnectionsState) => void, sessionId?: string): (() => void) => {
    const handler = (_event: IpcRendererEvent, state: MysqlConnectionsState, sourceSessionId?: string): void => {
      if (!sessionId || sessionId === sourceSessionId) listener(state)
    }
    ipcRenderer.on(IpcChannels.mysqlConnChanged, handler)
    return () => {
      ipcRenderer.removeListener(IpcChannels.mysqlConnChanged, handler)
    }
  },

  listRedisConnections: (): Promise<RedisConnectionsState> => ipcRenderer.invoke(IpcChannels.redisConnList),
  saveRedisConnection: (draft: RedisConnectionDraft): Promise<RedisSaveResult> => ipcRenderer.invoke(IpcChannels.redisConnSave, draft),
  removeRedisConnection: (id: string): Promise<RedisConnectionsState> => ipcRenderer.invoke(IpcChannels.redisConnRemove, id),
  testRedisConnection: (draft: RedisConnectionDraft): Promise<RedisConnectionResult> => ipcRenderer.invoke(IpcChannels.redisTestConnection, draft),
  scanRedisKeys: (draft: RedisConnectionDraft, cursor: string, search: string): Promise<RedisKeyPage> =>
    ipcRenderer.invoke(IpcChannels.redisScanKeys, draft, cursor, search),
  readRedisKey: (draft: RedisConnectionDraft, keyId: string, cursor: string): Promise<RedisKeyData> =>
    ipcRenderer.invoke(IpcChannels.redisReadKey, draft, keyId, cursor),
  onRedisConnectionChanged: (listener: (state: RedisConnectionsState) => void, sessionId?: string): (() => void) => {
    const handler = (_event: IpcRendererEvent, state: RedisConnectionsState, sourceSessionId?: string): void => {
      if (!sessionId || sessionId === sourceSessionId) listener(state)
    }
    ipcRenderer.on(IpcChannels.redisConnChanged, handler)
    return () => { ipcRenderer.removeListener(IpcChannels.redisConnChanged, handler) }
  },

  listNacosConnections: (): Promise<NacosConnectionsState> => ipcRenderer.invoke(IpcChannels.nacosConnList),

  saveNacosConnection: (draft: NacosConnectionDraft): Promise<NacosSaveResult> =>
    ipcRenderer.invoke(IpcChannels.nacosConnSave, draft),

  removeNacosConnection: (id: string): Promise<NacosConnectionsState> =>
    ipcRenderer.invoke(IpcChannels.nacosConnRemove, id),

  onNacosConnectionChanged: (listener: (state: NacosConnectionsState) => void, sessionId?: string): (() => void) => {
    const handler = (_event: IpcRendererEvent, state: NacosConnectionsState, sourceSessionId?: string): void => {
      if (!sessionId || sessionId === sourceSessionId) listener(state)
    }
    ipcRenderer.on(IpcChannels.nacosConnChanged, handler)
    return () => {
      ipcRenderer.removeListener(IpcChannels.nacosConnChanged, handler)
    }
  },

  openNacosView: (url: string): Promise<NacosViewState> =>
    ipcRenderer.invoke(IpcChannels.nacosOpen, url),

  navigateNacos: (url: string): Promise<NacosViewState> =>
    ipcRenderer.invoke(IpcChannels.nacosNavigate, url),

  sendNacosCommand: (command: EmbedCommand, sessionId?: string): void => {
    ipcRenderer.send(IpcChannels.nacosCommand, command, sessionId)
  },

  closeNacosView: (): Promise<NacosViewState> =>
    ipcRenderer.invoke(IpcChannels.nacosClose),

  setNacosBounds: (bounds: EmbedBounds, sessionId?: string): void => {
    ipcRenderer.send(IpcChannels.nacosSetBounds, bounds, sessionId)
  },

  setNacosVisible: (visible: boolean, sessionId?: string): void => {
    ipcRenderer.send(IpcChannels.nacosSetVisible, visible, sessionId)
  },

  getNacosState: (): Promise<NacosViewState> => ipcRenderer.invoke(IpcChannels.nacosGetState),

  onNacosState: (listener: (state: NacosViewState) => void, sessionId?: string): (() => void) => {
    const handler = (_event: IpcRendererEvent, state: NacosViewState, sourceSessionId?: string): void => {
      if (!sessionId || sessionId === sourceSessionId) listener(state)
    }
    ipcRenderer.on(IpcChannels.nacosState, handler)
    return () => {
      ipcRenderer.removeListener(IpcChannels.nacosState, handler)
    }
  },
  onEmbedState: (listener: (state: EmbedState) => void): (() => void) => {
    const handler = (_event: IpcRendererEvent, state: EmbedState): void => listener(state)
    ipcRenderer.on(IpcChannels.embedState, handler)
    return () => {
      ipcRenderer.removeListener(IpcChannels.embedState, handler)
    }
  },

  getUpdateStatus: (): Promise<UpdateStatus> => ipcRenderer.invoke(IpcChannels.updateGetState),
  checkForUpdates: (): Promise<UpdateStatus> => ipcRenderer.invoke(IpcChannels.updateCheck),
  downloadUpdate: (): Promise<UpdateStatus> => ipcRenderer.invoke(IpcChannels.updateDownload),
  installUpdate: (): Promise<void> => ipcRenderer.invoke(IpcChannels.updateInstall),

  onUpdateChanged: (listener: (status: UpdateStatus) => void): (() => void) => {
    const handler = (_event: IpcRendererEvent, status: UpdateStatus): void => listener(status)
    ipcRenderer.on(IpcChannels.updateChanged, handler)
    return () => {
      ipcRenderer.removeListener(IpcChannels.updateChanged, handler)
    }
  }
}

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error('[preload] failed to expose the API:', error)
  }
} else {
  // contextIsolation is enabled in this project; this is only a defensive fallback.
  ;(globalThis as unknown as { api: AppApi }).api = api
}
