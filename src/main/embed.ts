import { app, BrowserWindow, WebContentsView, session, shell } from 'electron'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { ContextUsageRecorder } from './context-usage-recorder'
import type { ContextUsageEntry } from '../shared/context-usage'
import { estimateContextText } from '../shared/focus-token-usage'
import type { ScheduledToolCall } from '../shared/scheduled-tasks'
import type { MailNotificationCall } from '../shared/mail-notification'
import type { ToolPromptReadCall } from '../shared/tool-prompts'
import type { TaskSubmission } from '../shared/autonomous-task'
import { validTaskQuestionSource, sameQuestionSource } from '../shared/task-clarification'
import type { TaskQuestion, TaskQuestionSource, TaskQuestionRequest } from '../shared/task-clarification'
import type { ComputerUseActionDefinition, ComputerUsePageRequest } from '../shared/computer-use'
import { createComputerUseProtocol } from '../shared/computer-use-protocol'
import type { TaskResultSendOutcome } from './task-progression'
import interceptorSource from './injected/send-interceptor.js?raw'
import themeSource from './injected/theme.js?raw'
import selectionQuestionSource from './injected/selection-question.js?raw'
import selectionQuestionCss from './injected/selection-question.css?raw'
import { SelectionQuestion } from './deepseek-question'
import { writeQuestionLog } from './question-chat-page'
import { supportsSelectionQuestion } from '../shared/deepseek-question'
import type { QuestionChatAction, QuestionChatState, SelectionQuestionDraft } from '../shared/deepseek-question'
import type { SavedQuestionContextReader } from '../shared/deepseek-context-markdown'
import type { FocusPageSnapshot, FocusSendOutcome, FocusAttachmentInfo, FocusEditDiagnostic, FocusModelSettingsRequest, FocusModelSettingsResult } from '../shared/focus-chat'
import { supportsFocusView, validFocusComposerModes, validFocusModelSettings, validFocusSendFailure } from '../shared/focus-chat'
import { sendPageFiles } from './page-files'
import { writeRawSendDiagnostic } from './raw-send-log'
import { writeInjectionPlanDiagnostic, writePromptDiagnostic } from './prompt-log'
import type { InjectionPlan } from '../shared/prompt-injection'
import { writeReplyDiagnostic } from './reply-log'
import { observeFocusEditRequest, observeFocusPageRequest } from './focus-edit-request'
import { smartUiSubmission } from './focus-ui-request'
import { dispatchFocusUiClick } from './focus-ui-click'
import { dispatchFocusModelClick } from './focus-model-click'
import type { FocusUiAction, FocusUiRecovery } from '../shared/focus-smart-ui'
import { parseReadFilesRequest } from '../shared/file-requests'
import type { FileSendOutcome } from '../shared/file-requests'
import type { PreparedFileResult, PreparedAttachment } from './file-access'
import { FALLBACK_ENVIRONMENT, buildTerminalPromptParts, fileReadingPlatform, isConversationId,
  REPLY_PROTOCOL_VERSION, REPLY_PROTOCOL_SECTION, REPLY_PROTOCOL_REMINDER, withReplyProtocol } from '../shared/types'
import type { ChatPlatform } from '../shared/platforms'
import type {
  AppTheme,
  ConversationImageAttachmentInput,
  EmbedBounds,
  EmbedCommand,
  EmbedState,
  InterceptorPageEvent,
  InterceptorStatus,
  CommandRecoveryState,
  TerminalPromptParts,
  PendingQuestionItem,
  ParsedAction,
  ScrapedConversation
} from '../shared/types'

/**
 * Hosts one chat site in a native `WebContentsView` layered on top of the React
 * renderer.
 *
 * Which site is decided by the `ChatPlatform` descriptor it is constructed with; nothing
 * in here may assume ChatGPT. The site-specific pieces (URLs, navigation policy,
 * conversation-id shape, sidebar scraper, and the page descriptor the injected script
 * runs against) all live in `shared/platforms.ts`.
 *
 * Why not an `<iframe>`: these sites refuse to be framed (`X-Frame-Options` /
 * CSP `frame-ancestors`), so the page can only be embedded out-of-process.
 *
 * Why a dedicated partition: the embedded page gets its own cookie jar, so
 * third-party content can never touch the app's own session — and the two platforms get
 * a jar each, so signing into one never signs into the other.
 *
 * IMPORTANT: a native view is not a DOM node. It always paints *above* the
 * renderer, so React must keep the measured slot clear of overlapping UI.
 */

/** Tag the injected page script prefixes its console reports with. */
const INTERCEPTOR_LOG_TAG = '[cmd-terminal] '

/**
 * How often to ask whether a bot check has cleared.
 *
 * Two seconds because the measured wait is ~24 seconds: fine-grained enough that the UI stops
 * saying "passing a security check" promptly after it does, coarse enough that a page whose
 * challenge takes a minute does not get hammered with `executeJavaScript` calls.
 */
const BOT_CHECK_POLL_MS = 2000

/**
 * Conversation id of a URL, for whichever platform this view drives.
 *
 * A URL that will not parse is not an error worth reporting — the page navigates through
 * intermediate states constantly — so it answers "not a conversation", which is the safe
 * reading: nothing gets written to the database.
 */
function conversationIdOf(platform: ChatPlatform, url: string): string | null {
  try {
    return platform.conversationIdFromPath(new URL(url).pathname)
  } catch {
    return null
  }
}

/**
 * A stock Electron UA advertises `Electron/44.4.3`; Cloudflare's bot rules on
 * chatgpt.com reject that, so present a plain Chrome user agent instead.
 */
function chromeLikeUserAgent(): string {
  const platformToken =
    process.platform === 'win32'
      ? 'Windows NT 10.0; Win64; x64'
      : process.platform === 'darwin'
        ? 'Macintosh; Intel Mac OS X 10_15_7'
        : 'X11; Linux x86_64'

  return (
    `Mozilla/5.0 (${platformToken}) AppleWebKit/537.36 (KHTML, like Gecko) ` +
    `Chrome/${process.versions.chrome} Safari/537.36`
  )
}

/**
 * What a real Chrome advertises in `Sec-CH-UA`, and the second half of the identity above.
 *
 * WHY THIS EXISTS. `setUserAgent` changes one request header. It does not change the CLIENT HINT
 * brand list, which Electron reports as `["Not?A_Brand","Chromium"]` — with no `"Google Chrome"`
 * in it. So every request said *same User-Agent as Chrome, different browser*, which is exactly
 * what a browser pretending to be Chrome looks like, and Cloudflare's challenge on claude.ai
 * would not let the page past it. Measured: the probe sat on 正在验证您是否是真人 indefinitely
 * with a Chrome User-Agent and no hint rewrite, and loaded immediately once the rewrite was
 * added. Electron 44 has no `setUserAgentMetadata`, so these headers are the only lever.
 */
function chromeBrandList(): string {
  const version = String(process.versions.chrome)
  const major = version.split('.')[0]
  return `"Google Chrome";v="${major}", "Chromium";v="${major}", "Not(A:Brand";v="24"`
}

function chromeFullVersionList(): string {
  const version = String(process.versions.chrome)
  return `"Google Chrome";v="${version}", "Chromium";v="${version}", "Not(A:Brand";v="24.0.0.0"`
}

/**
 * Hosts where Google decides whether a sign-in is admitted, and whether the session it creates
 * keeps renewing afterwards. These two present FIREFOX instead of the Chrome identity above.
 *
 * WHY. Measured by another Electron app (stablyai/orca#11518 and #12884, Electron 43, macOS), and
 * confirmed here for the part that matters first: with this identity a Gemini sign-in completed
 * inside the embed (user-run, Electron 44, Windows, 2026-10-14). Whether the session keeps
 * renewing past the hour is what the cookie log below is for. The measurement:
 *
 *  - A User-Agent shaped exactly like stock Chrome, which is what `chromeLikeUserAgent` produces,
 *    was sent to `/v3/signin/rejected` 12 times out of 12. Forged client hints, anti-detection
 *    scripts and an attached debugger made no difference either way.
 *  - A session that did get in under an Electron/Chrome-shaped identity stopped rotating
 *    `__Secure-1PSIDTS` / `__Secure-3PSIDTS` and was dead in about an hour; re-importing cookies
 *    from a desktop browser only restarted that clock.
 *  - Firefox on exactly these two hosts, with the Chromium client hints removed, was admitted and
 *    kept the session renewing every ~10 minutes for 8h+.
 *
 * Both refusals this repo recorded earlier (`google-login-probe.js`, `gemini-dom-probe.js`) were
 * taken with the Chrome-shaped identity, so they say nothing about this one.
 *
 * Exact hostname match, so a lookalike such as `accounts.google.com.evil.test` never qualifies.
 * Every other host — gemini.google.com included — keeps the Chrome identity, because that is
 * what Cloudflare on the other two sites needs and what Gemini itself was measured against.
 */
const GOOGLE_AUTH_HOSTS = new Set(['accounts.google.com', 'accounts.youtube.com'])

function isGoogleAuthUrl(url: string): boolean {
  try {
    return GOOGLE_AUTH_HOSTS.has(new URL(url).hostname.toLowerCase())
  } catch {
    return false
  }
}

/** The version the measurement above used. Bump it if Google starts calling it outdated. */
const FIREFOX_VERSION = '140.0'

function googleAuthUserAgent(): string {
  const platformToken =
    process.platform === 'win32'
      ? 'Windows NT 10.0; Win64; x64'
      : process.platform === 'darwin'
        ? 'Macintosh; Intel Mac OS X 10.15'
        : 'X11; Linux x86_64'

  return `Mozilla/5.0 (${platformToken}; rv:${FIREFOX_VERSION}) Gecko/20100101 Firefox/${FIREFOX_VERSION}`
}

/** Origin and path only: Google's sign-in URLs carry continue URLs and account hints in the query. */
function urlForLog(url: string): string {
  try {
    const parsed = new URL(url)
    return `${parsed.origin}${parsed.pathname}`
  } catch {
    return '(unparseable url)'
  }
}

/**
 * The cookies whose movement says whether a Google session is alive.
 *
 * The `*PSIDTS` / `*SIDCC` ones are the short-lived half: a healthy session re-sets them every few
 * minutes, and the measured failure looked like exactly those going quiet — absent or frozen at
 * the time of sign-in — about an hour before the page signed out.
 */
const GOOGLE_SESSION_COOKIES = new Set([
  'SID',
  '__Secure-1PSID',
  '__Secure-3PSID',
  '__Secure-1PSIDTS',
  '__Secure-3PSIDTS',
  'SIDCC',
  '__Secure-1PSIDCC',
  '__Secure-3PSIDCC'
])

const googleCookiesWatched = new Set<string>()

/**
 * Log every write to a Google session cookie in this partition — name, length and expiry, NEVER
 * the value — so whether a session keeps renewing can be read off the app log after an hour or
 * more instead of being guessed at.
 */
function watchGoogleSessionCookies(partition: string): void {
  if (googleCookiesWatched.has(partition)) return
  googleCookiesWatched.add(partition)

  const ses = session.fromPartition(partition)

  ses.cookies.on('changed', (_event, cookie, cause, removed) => {
    if (!GOOGLE_SESSION_COOKIES.has(cookie.name)) return
    const domain = (cookie.domain ?? '').replace(/^\./, '').toLowerCase()
    if (domain !== 'google.com' && !domain.endsWith('.google.com')) return
    // A rotation arrives as the old value being removed and the new one set; the second says it all.
    if (removed && cause === 'overwrite') return

    const expiry =
      typeof cookie.expirationDate === 'number'
        ? `expires ${new Date(cookie.expirationDate * 1000).toISOString()}`
        : 'session-only'
    console.info(
      `[embed] google cookie ${removed ? `removed (${cause})` : 'set'} on ${partition}: ` +
        `${cookie.name} @${cookie.domain ?? '?'} len=${cookie.value.length} ${expiry}`
    )
  })

  void ses.cookies
    .get({ domain: 'google.com' })
    .then((cookies) => {
      const present = [...new Set(cookies.map((cookie) => cookie.name))].filter((name) =>
        GOOGLE_SESSION_COOKIES.has(name)
      )
      console.info(
        `[embed] google session cookies on ${partition} at start: ${present.length > 0 ? present.join(', ') : '(none)'}`
      )
    })
    .catch(() => {})
}

/** Partitions already patched. `onBeforeSendHeaders` holds ONE handler, so this must be once. */
const identityPatched = new Set<string>()

/** Partitions whose patch has already been reported, so the log carries one line each. */
const identityLogged = new Set<string>()

/** The same, for the Google auth identity. */
const googleAuthIdentityLogged = new Set<string>()

/**
 * Make the client hints agree with the User-Agent the view already presents.
 *
 * ONE handler for the whole partition, and installed once: Electron keeps a single
 * `onBeforeSendHeaders` slot per session, so a second registration silently REPLACES the first.
 * Registering a separate observer alongside this would therefore either vanish or disable the
 * patch, and the log would then disagree with the wire.
 *
 * Applied to EVERY embedded partition, not just Claude's. Every view already sends a Chrome
 * User-Agent, so a brand list that disagrees with it is a fingerprint on all three sites — there
 * is nothing site-specific about this, and scoping it to the one site that happened to break
 * first would leave the same inconsistency behind on the other two.
 *
 * The one exception is requests TO a Google auth host (see `GOOGLE_AUTH_HOSTS`), which get the
 * Firefox identity instead. It lives in this same handler because there is only one slot.
 */
function installChromeIdentity(partition: string): void {
  if (identityPatched.has(partition)) return
  identityPatched.add(partition)

  session.fromPartition(partition).webRequest.onBeforeSendHeaders(
    { urls: ['*://*/*'] },
    (details, callback) => {
      const headers = { ...details.requestHeaders }
      let touched = false
      const googleAuth = isGoogleAuthUrl(details.url)

      for (const name of Object.keys(headers)) {
        const lower = name.toLowerCase()
        if (googleAuth) {
          /*
           * Every `sec-ch-ua*` goes, not just the brand list: real Firefox sends no client hints
           * at all, and Chromium's hints under a Firefox User-Agent are a sharper tell than
           * either identity on its own.
           */
          if (lower.startsWith('sec-ch-ua')) {
            delete headers[name]
            touched = true
          } else if (lower === 'user-agent') {
            headers[name] = googleAuthUserAgent()
            touched = true
          }
          continue
        }
        if (lower === 'sec-ch-ua') {
          headers[name] = chromeBrandList()
          touched = true
        } else if (lower === 'sec-ch-ua-full-version-list') {
          headers[name] = chromeFullVersionList()
          touched = true
        } else if (lower === 'sec-ch-ua-full-version') {
          headers[name] = `"${String(process.versions.chrome)}"`
          touched = true
        } else if (lower === 'user-agent') {
          headers[name] = chromeLikeUserAgent()
          touched = true
        }
      }

      if (touched && googleAuth) {
        if (!googleAuthIdentityLogged.has(partition)) {
          googleAuthIdentityLogged.add(partition)
          console.info(
            `[embed] google auth identity on ${partition}: ${urlForLog(details.url)} -> ` +
              `${JSON.stringify(googleAuthUserAgent())}, sec-ch-ua* removed`
          )
        }
      } else if (touched) {
        /*
         * Logged once per partition, with the value that was there before.
         *
         * Without the before-value a failed load cannot be told apart from a patch that never
         * applied — and "the patch silently did nothing" is the failure this whole area exists
         * to avoid. Note the hint is often ABSENT rather than wrong, because Chromium only sends
         * `sec-ch-ua` on requests that opt into it.
         */
        if (!identityLogged.has(partition)) {
          identityLogged.add(partition)
          const key = Object.keys(details.requestHeaders || {}).find(
            (candidate) => candidate.toLowerCase() === 'sec-ch-ua'
          )
          console.info(
            `[embed] chrome identity on ${partition}: sec-ch-ua ` +
              `${JSON.stringify(key ? details.requestHeaders[key] : '(absent)')} -> ` +
              `${JSON.stringify(chromeBrandList())}`
          )
        }
      }

      return callback({ requestHeaders: headers })
    }
  )
}

function normalizeUrl(input: string): string | null {
  const trimmed = input.trim()
  if (trimmed === '') return null
  const candidate = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
  try {
    return new URL(candidate).toString()
  } catch {
    return null
  }
}

/**
 * NAVIGATION IS NO LONGER POLICED, and this note is the record of why.
 *
 * The view used to allow only the platform's own hosts (`ChatPlatform.allowedOriginPattern`) and
 * hand everything else to the system browser. That existed for one reason: to keep third-party
 * sign-in out of the embedded user-agent, because Google refuses it there (`accounts.google.com`
 * answers `/v3/signin/rejected` — measured, and recorded beside `EMBED_LOGIN_URL`).
 *
 * It was removed because it broke loading outright on claude.ai. Cloudflare's challenge navigates
 * through `challenges.cloudflare.com`, which was never on any platform's list, so the interstitial
 * could not complete and the page re-challenged every ~15 seconds forever. A site that cannot load
 * at all is a worse trade than losing an escape hatch to a sign-in route this repo had already
 * measured as failing.
 *
 * The consequence, stated plainly so nobody has to rediscover it: **a Google sign-in started in
 * the embedded view now runs to that refusal instead of escaping to a browser that would have
 * completed it.** Email/OTP sign-in is unaffected, and it is what the ChatGPT platform supports.
 * That refusal was measured under the Chrome identity; the auth hosts now present Firefox instead
 * (`GOOGLE_AUTH_HOSTS`), under which Gemini's own sign-in completes. A Google sign-in into ChatGPT
 * or Claude passes the same hosts but has not been tried.
 *
 * Ordinary outbound links are unchanged — a new window the page asks for still opens in the real
 * browser (see `openExternalUrl`).
 */

/**
 * Runs inside the embedded page (main world).
 *
 * Each sidebar entry is rendered as:
 *   <li class="list-none">
 *     <a data-sidebar-item="true" aria-label="æ­Œæ›²åç§°ä»‹ç»"
 *        href="/c/6ab11ffa-64b8-83e8-9247-c19ae00ad95e">…</a>
 *   </li>
 *
 * The aria-label carries the conversation name; textContent is the fallback for
 * the unordered history list, which renders the label differently.
 *
 * The script itself now lives on the platform descriptor (`sidebarScript`), because the
 * link shape differs per site. Only the raw path segment is extracted there — validating
 * it is left to `isConversationId()` so that rule lives in exactly one place.
 */

interface ScrapeResult {
  id: string
  title: string
}

/** Callbacks the embed raises towards the main process. */
export interface EmbedHandlers {
  contextTurnId?(conversationId: string | null): string | undefined
  onContextUsage?(entry: ContextUsageEntry): void
  onState(state: EmbedState): void
  onQuestionChat?(state: QuestionChatState | null): void
  readQuestionContext?: SavedQuestionContextReader
  /** A conversation the page just navigated to (auto-saved). */
  onConversation(conversation: ScrapedConversation): void
  /** Results of a background sidebar scrape. */
  onSynced(conversations: ScrapedConversation[]): void
  /** Terminal-mode interceptor changed state. */
  onInterceptor(status: InterceptorStatus): void
  /** Conversation history survives task completion and page/app reloads. */
  hasConversationPrompt?(conversationId: string): boolean
  onPromptInjected?(conversationId: string | null): void
  /** The prefix the next task start carries, chosen from what this conversation already holds. */
  planInjection?(fullPrefix: string, conversationId: string | null): InjectionPlan | null
  /** A confirmed send carried a prefix; `plan` is null when the page's prefix no longer matches the plan. */
  onInjectionSent?(conversationId: string | null, plan: InjectionPlan | null): void
  /** An edit-and-resend drops later turns, possibly the one that held the prompt. */
  onConversationBranched?(conversationId: string | null): void
  /** Clean user text, with the injected system prefix already removed. */
  onUserStarted?(text: string, files?: FocusAttachmentInfo[], editToken?: string, submission?: TaskSubmission, scheduledRunId?: string): string | undefined
  onScheduledTask?(request: ScheduledToolCall): void
  onMailNotification?(request: MailNotificationCall): void
  onToolPromptRead?(request: ToolPromptReadCall): void
  onUserMessage(text: string, attachments: ConversationImageAttachmentInput[], focusTurnId?: string, imageSource?: 'provided' | 'page'): void
  onRawSent?(textLength: number): void
  /** Attachments the page sent, as an estimate of the context they take, in characters. */
  onContextTraffic?(chars: number): void
  /** An assistant message that belongs in the app's conversation transcript. */
  onAssistantMessage(messageId: string, text: string): void
  /** Re-read Markdown for an already stored assistant turn in restored history. */
  onAssistantHistoryMarkdown(messageId: string, text: string): void
  /** The model's reply contained a command. */
  onCommand(command: ParsedAction): void
  /** Raw desktop envelope recognition, kept separate from all executable command types. */
  onComputerRequest?(request: ComputerUsePageRequest): boolean
  onComputerDocumentChanged?(): void
  /** An explicitly marked plain-text reply reports that the task is complete. */
  onQuestion(question: string, count: number): void
  /** A question reply's JSON, live or from history, to keep for 重新执行指令. */
  onQuestionRecorded(messageId: string, rawJson: string): void
  onTaskQuestion?(question: TaskQuestion, source: TaskQuestionSource): void
  onTaskCompleted(messageId?: string, source?: import('../shared/types').TaskActionSource): boolean | void
  /**
   * This view finished loading its page for the first time since it was created.
   *
   * Fired ONCE per view, from the first did-stop-loading: the startup splash listens
   * for it so the animation ends when the page is actually ready rather than after a
   * guessed delay. A later reload does not re-fire it.
   */
  onReady?(): void
  /**
   * A reply looked like it carried a command but could not be parsed.
   *
   * Surfaced on purpose: dropping it silently is indistinguishable from the app
   * being broken, which is exactly how the unescaped-quote bug stayed hidden.
   */
  onParseFailed(payload: InterceptorPageEvent): void
  onCommandRecovery?(recovery: CommandRecoveryState): void
}

export class ChatGptEmbed {
  private view: WebContentsView | null = null
  private hiddenViewProbe: { active(waiting?: boolean): void; note(reason: string): void; stop(): void } | null = null
  private selectionQuestion: SelectionQuestion | null = null
  private bounds: EmbedBounds = { x: 0, y: 0, width: 0, height: 0 }
  private visible = true
  /** Dedupe key of the last conversation handed to the store. */
  private lastCaptured = ''
  /** Dedupe key of the last `reportLanding` line, so a re-titling page cannot flood the log. */
  private lastLanding = ''
  /**
   * When the current bot check started, or null when there is none.
   *
   * Non-null is what `EmbedState.botCheckSince` reports, which is how the UI knows to say
   * "passing a security check" instead of showing a page that looks broken.
   */
  private botCheckSince: number | null = null
  /** Poll watching a bot check resolve itself; see `beginBotCheckWait`. */
  private botCheckTimer: NodeJS.Timeout | null = null
  private lastSyncAt = 0
  /** Whether onReady has already been reported for this view. See EmbedHandlers.onReady. */
  private firstLoadDone = false

  /**
   * Terminal mode is ON by default: the first user send in each task carries
   * the system prompt; later sends still use the confirmed user-message path.
   */
  private interceptor: InterceptorStatus = {
    enabled: true,
    promptInjectionEnabled: true,
    installed: false,
    injectedCount: 0,
    lastSentText: null,
    taskStartedAt: null,
    taskFinishedAt: null,
    pendingQuestion: null,
    // A safe default until main has probed the machine and calls
    // setPromptParts(); see buildTerminalPrompt().
    ...buildTerminalPromptParts(FALLBACK_ENVIRONMENT)
  }
  /** Kept per view so a full page reload preserves the current task's injection. */
  private taskPromptInjected = false
  private readonly contextUsage = new ContextUsageRecorder(() => {
    const contents = this.liveContents()
    const conversationId = contents ? conversationIdOf(this.platform, contents.getURL()) : null
    return { conversationId, turnId: this.handlers.contextTurnId?.(conversationId) ?? null }
  }, entry => this.handlers.onContextUsage?.(entry))
  /** The plan behind the prefix last pushed to the page, and the length the page last injected. */
  private injectionPlan: InjectionPlan | null = null
  private pushedPrefix: string | null = null
  private injectedPrefixLength: number | null = null
  private toolPromptRevision = 0
  private taskPromptGeneration = 0
  private computerUseRecognitionEnabled = false
  /** The page holds the user's own sends while this is set; see computerUseSendBlock(). */
  private sendBlock: string | null = null
  private computerPageEpoch = randomUUID()
  private taskQuestion: { messageId: string; source: TaskQuestionSource } | null = null
  private taskQuestionBindings = new Map<string, TaskQuestionSource>()
  private taskQuestionContext: { messageId: string; owner: TaskQuestionRequest } | null = null
  private computerUseProtocolContext: { definitions: ComputerUseActionDefinition[]; stepToken: string | null } = { definitions: [], stepToken: null }
  private replyDiagnosticLogPath: string | null = null
  private readonly focusSendImages = new Map<string, ConversationImageAttachmentInput[]>()
  private readonly userSubmissions = new Set<string>()

  /**
   * Replace the injected prompt.
   *
   * The prompt describes the machine, which is only known after a startup probe,
   * so it cannot be a compile-time constant. Re-installs into a live page so the
   * change takes effect on the next send rather than the next reload.
   */
  setPromptParts(parts: TerminalPromptParts, refreshTools = false): void {
    if (!refreshTools && this.interceptor.prefix === parts.prefix &&
        this.interceptor.basePrompt === parts.basePrompt &&
        this.interceptor.toolPrompt === parts.toolPrompt) return
    // New tool choices apply to the next human send without invalidating a live step or question.
    if (refreshTools) { this.taskPromptInjected = false; this.toolPromptRevision += 1 }
    Object.assign(this.interceptor, parts)
    this.handlers.onInterceptor(this.getInterceptorStatus())
    // Machine/prompt changes keep the current conversation and pending answer alive.
    if (this.liveContents()) void this.installInterceptor(false)
  }

  /**
   * The colour this view paints before its page has painted anything.
   *
   * Matches the renderer's `--bg-elevated` in each theme, so the native rectangle in the slot
   * blends with the app instead of announcing itself — a dark rectangle in a light app while
   * the page loads is the most visible form of "the embed is not part of this window".
   */
  private backgroundColor(): string {
    return this.theme === 'dark' ? '#141922' : '#ffffff'
  }

  /**
   * Push the app's theme into this page.
   *
   * Two mechanisms, deliberately, and neither covers the other's case:
   *
   *   1. `nativeTheme.themeSource`, set once in the main process (`applyAppTheme`). It makes
   *      this renderer answer `prefers-color-scheme` with the app's theme, which is enough
   *      for a site whose own appearance follows the system — the default on all four.
   *   2. The injected script, for a site pinned to an explicit light or dark in its own
   *      settings, where the media query is ignored and only the page's own DOM responds.
   *
   * Applied live, not at the next reload: the setting is a switch the user just flipped, and
   * a page that only changes theme after a manual reload reads as broken.
   */
  setTheme(theme: AppTheme): void {
    this.theme = theme
    this.selectionQuestion?.setTheme(theme)
    const view = this.view
    if (view && !view.webContents.isDestroyed()) view.setBackgroundColor(this.backgroundColor())
    if (this.liveContents()) {
      void this.installTheme()
      void this.installSelectionQuestion()
    }
  }

  /**
   * When true, a page that (re)loads starts with its restored history suppressed.
   * Main keeps this in sync with the execution mode.
   */
  private armBaselineOnInstall = false

  /**
   * The app's theme, pushed into the page by `installTheme()`.
   *
   * Held per view rather than read from settings at use time: a view outlives a settings
   * change and reloads on its own, and a page that reloads has to be told again. The value
   * also decides the colour a loading view paints, so a cold load cannot flash the opposite
   * theme into the slot.
   */
  private theme: AppTheme = 'light'

  /**
   * Which site this view drives.
   *
   * Required, not defaulted: a default would let a second platform silently inherit
   * ChatGPT's partition and URL patterns, which is the exact kind of mix-up that is
   * invisible until someone is signed into the wrong account.
   */
  constructor(
    private readonly platform: ChatPlatform,
    private readonly handlers: EmbedHandlers,
    private readonly initialUrl: string = platform.homeUrl
  ) {}

  /** Create the view and add it to the window. Safe to call more than once. */
  attach(parent: BrowserWindow): void {
    if (this.view && !this.view.webContents.isDestroyed()) return

    // Before the view exists, so the very first request of the very first navigation already
    // carries a brand list that agrees with the User-Agent below.
    installChromeIdentity(this.platform.partition)
    watchGoogleSessionCookies(this.platform.partition)

    const view = new WebContentsView({
      webPreferences: {
        partition: this.platform.partition,
        // Untrusted third-party content: no bridge, no Node, sandboxed.
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
        spellcheck: false,
        // ChatGPT reply detection must keep running while the app is minimized.
        backgroundThrottling: false
      }
    })

    this.view = view
    /*
     * What the view paints before its page has painted anything. It has to follow the app
     * theme, or every cold load and every switch back flashes the opposite one into the slot
     * — the value is the renderer's own `--bg-elevated` in each theme.
     */
    view.setBackgroundColor(this.backgroundColor())
    parent.contentView.addChildView(view)

    const contents = view.webContents
    // User-run, metadata-only diagnostics against THIS view, never a second Electron/page.
    // The tools file stays outside the product bundle and is loaded only by explicit dev opt-in.
    if (!app.isPackaged && process.env.WEB2TERM_HIDDEN_VIEW_DIAG === '1' && this.platform.id === 'deepseek') {
      try {
        const probe = createRequire(join(app.getAppPath(), 'package.json'))(
          join(app.getAppPath(), 'tools', 'diag', 'deepseek-hidden-view-probe.cjs'))
        this.hiddenViewProbe = probe.attachExistingView(view, { nativeState: () => {
          const actual = view.getBounds(), [width, height] = parent.getContentSize()
          return { requestedVisible: this.visible, nativeVisible: view.getVisible(), requestedBounds: { ...this.bounds }, actualBounds: actual,
            windowWidth: width, windowHeight: height, windowVisible: parent.isVisible(), minimized: parent.isMinimized(),
            clippedWidth: Math.max(0, Math.min(width, actual.x + actual.width) - Math.max(0, actual.x)),
            clippedHeight: Math.max(0, Math.min(height, actual.y + actual.height) - Math.max(0, actual.y)),
            pageZoom: contents.getZoomFactor(), appZoom: parent.webContents.getZoomFactor() }
        } })
      } catch { console.warn('[embed:deepseek] hidden-view diagnostic could not be loaded') }
    }
    const baseUserAgent = process.env.EMBED_USER_AGENT ?? chromeLikeUserAgent()
    contents.setUserAgent(baseUserAgent)
    if (supportsSelectionQuestion(this.platform.id)) {
      this.selectionQuestion = new SelectionQuestion(contents, parent, this.platform, () => this.theme,
        state => this.handlers.onQuestionChat?.(state), id => this.handlers.readQuestionContext?.(id) ?? null)
      this.selectionQuestion.setVisible(this.visible)
    }

    /*
     * Keep `navigator.userAgent` in step with the header on the Google auth hosts.
     *
     * The header is already Firefox there (`installChromeIdentity`), but a page reads its own
     * identity from the view, and a sign-in page whose script says Chrome while every request
     * says Firefox is the two-identity split the measurement warned about.
     *
     * Switched in `did-start-navigation` and nowhere else: an override set there is applied to
     * the navigation that is starting, whereas Chromium answers one set later in a load by
     * reloading the page. So a REDIRECT into or out of an auth host commits with the previous
     * script-visible identity — the header is still right, and that is what Google's servers
     * see — and the next navigation puts it back.
     *
     * Main-frame navigations on the auth hosts are logged by path, in-page ones included: the
     * sign-in steps are mostly in-page, and `/v3/signin/rejected` vs. a password or challenge
     * step is the whole answer to "was this sign-in admitted".
     */
    const followGoogleAuthIdentity = (url: string, isSameDocument: boolean, kind: string): void => {
      const googleAuth = isGoogleAuthUrl(url)
      if (googleAuth) {
        console.info(
          `[embed:${this.platform.id}] google auth ${kind}${isSameDocument ? ' (in-page)' : ''}: ${urlForLog(url)}`
        )
      }
      if (isSameDocument || kind !== 'navigation') return

      const wanted = googleAuth ? googleAuthUserAgent() : baseUserAgent
      if (contents.getUserAgent() === wanted) return
      contents.setUserAgent(wanted)
      console.info(
        `[embed:${this.platform.id}] page identity -> ${googleAuth ? 'firefox' : 'chrome'} for ${urlForLog(url)}`
      )
    }
    contents.on('did-start-navigation', (details) => {
      if (details.isMainFrame && !details.isSameDocument) this.invalidateComputerDocument()
      if (details.isMainFrame) followGoogleAuthIdentity(details.url, details.isSameDocument, 'navigation')
    })
    contents.on('did-redirect-navigation', (details) => {
      if (details.isMainFrame) followGoogleAuthIdentity(details.url, false, 'redirect')
    })

    // Ordinary outbound links — a new window the page asks for — still go to the real browser.
    // Navigation the page performs ITSELF is no longer policed; see `isAllowedNavigation`.
    const openExternalUrl = (url: string): void => {
      try {
        const parsed = new URL(url)
        console.info(`[embed] opening external navigation: ${parsed.origin}${parsed.pathname}`)
      } catch {
        console.info('[embed] opening external navigation')
      }

      void shell.openExternal(url).catch((error) => {
        console.warn('[embed] external navigation failed:', (error as Error).message)
      })
    }

    contents.setWindowOpenHandler(({ url }) => {
      openExternalUrl(url)
      return { action: 'deny' }
    })

    // The injected script reports through console.log, because the page has no
    // preload and therefore no IPC bridge. This is a one-way, parse-only channel.
    contents.on('console-message', (details) => {
      this.handlePageReport(details.message)
    })

    /*
     * Name the failures.
     *
     * Chromium prints `handshake failed … net_error -100` with NO host, which is not enough
     * to act on — two platforms are embedded at once and either could be the one dying. These
     * events carry the URL, so a log can answer "which request, to where".
     */
    contents.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
      // -3 is ERR_ABORTED: a navigation superseded by another, which is routine here.
      if (code === -3) return
      console.warn(
        `[embed:${this.platform.id}] load failed ${code} ${description} ` +
          `${isMainFrame ? 'main' : 'sub'} ${url}`
      )
    })
    contents.on('did-fail-provisional-load', (_event, code, description, url) => {
      if (code === -3) return
      console.warn(`[embed:${this.platform.id}] provisional load failed ${code} ${description} ${url}`)
    })
    contents.on('certificate-error', (_event, url, error) => {
      console.warn(`[embed:${this.platform.id}] certificate error ${error} ${url}`)
    })

    // Re-inject on every full page load; client-side route changes keep the
    // document-level listeners installed by the previous run.
    contents.on('did-finish-load', () => {
      void this.installInterceptor()
      void this.installTheme()
      void this.installSelectionQuestion()
      this.keepRenderingWhileHidden()
    })

    /*
     * The theme goes in at `dom-ready`, which is the EARLIEST moment there is a document to
     * touch — the page's own styles are applied by then, and the theme script measures them.
     * Waiting for `did-finish-load` would leave the page in its own theme for the whole of a
     * long load, which on a cold start is the several seconds the splash is up.
     */
    contents.on('dom-ready', () => {
      this.keepRenderingWhileHidden()
      void this.installTheme()
      void this.installSelectionQuestion()
    })

    // NOTE: `did-navigate-in-page` is the one that fires for ChatGPT's
    // client-side route changes (`/` -> `/c/<uuid>` without a page load).
    contents.on('did-start-loading', () => this.publishState())
    contents.on('did-stop-loading', () => {
      this.publishState()
      this.captureCurrentConversation()
      this.autoSync()
      /*
       * The first stop is what the startup splash is waiting for. Reported after the
       * state push above so the UI behind the splash is already consistent when it goes
       * away. Only the first one counts: a reload mid-session is not a startup.
       */
      if (!this.firstLoadDone) {
        this.firstLoadDone = true
        this.handlers.onReady?.()
      }
    })
    contents.on('did-navigate', () => {
      this.publishState()
      this.captureCurrentConversation()
    })
    contents.on('did-navigate-in-page', () => {
      this.keepRenderingWhileHidden()
      this.publishState()
      this.captureCurrentConversation()
      this.dismissSelectionQuestion()
      void this.installSelectionQuestion()
    })
    contents.on('page-title-updated', () => {
      this.publishState()
      this.captureCurrentConversation()
      // The challenge page often finishes loading BEFORE it swaps its title in, so this is the
      // event that catches it. See `reportLanding`.
      void this.reportLanding()
    })
    contents.on('render-process-gone', () => this.publishState())

    // Allocate the real native content viewport while the new view is still blank,
    // then apply the requested visibility BEFORE any third-party page is loaded.
    // Loading first and setting bounds only after hiding leaves a lazy platform at 0x0.
    this.applyBounds()
    void contents.loadURL(this.initialUrl || this.platform.homeUrl)
  }

  setBounds(bounds: EmbedBounds): void {
    this.bounds = bounds
    this.applyBounds()
  }

  /**
   * Say where the view actually LANDED, and recognise a bot-check interstitial by name.
   *
   * WHY THIS EXISTS. `did-navigate` and `page-title-updated` only republish state, so a view
   * parked on a Cloudflare challenge produced a completely silent log: the session was created,
   * `configure` reported the prompt as MATCH, and nothing anywhere said "you are looking at a
   * security check rather than the site". That silence cost a full debugging round on claude.ai
   * — and the same class of page has already been mistaken for a login failure on chatgpt.com
   * and for a rate-limit page on auth.openai.com.
   *
   * Recognised the way the probes do it: by title, with the body text as a second signal, since
   * a challenge page carries almost no other markup. Reported only when it CHANGES, so a page
   * that keeps re-titling itself cannot flood the log.
   */
  private async reportLanding(): Promise<void> {
    const contents = this.liveContents()
    if (!contents) return

    const url = contents.getURL()
    const title = contents.getTitle()
    let body = ''
    try {
      body = String(
        await contents.executeJavaScript(
          'document.body ? document.body.innerText.slice(0, 300) : ""'
        )
      )
    } catch {
      /* a navigation during the read is normal */
    }

    const challenged = this.looksLikeBotCheck(title, body)
    const line = `${url}|${title}|${challenged ? 'CHALLENGE' : 'ok'}`
    if (line === this.lastLanding) return
    this.lastLanding = line

    if (challenged) {
      console.warn(
        `[embed:${this.platform.id}] BOT CHECK, not the site: ${url} | title=${JSON.stringify(title)} ` +
          `| ${JSON.stringify(body.slice(0, 120))}`
      )
      this.beginBotCheckWait(contents)
    } else {
      console.info(`[embed:${this.platform.id}] landed ${url} | title=${JSON.stringify(title)}`)
      this.endBotCheckWait()
    }
  }

  /** Whether this document is a bot-check interstitial rather than the site. */
  private looksLikeBotCheck(title: string, body: string): boolean {
    return /just a moment|verify you are human|checking your browser|正在进行安全验证|验证您是否是真人|安全服务防护/i.test(
      `${title}\n${body}`
    )
  }

  /**
   * Wait for a bot check to clear, and say so while it does.
   *
   * WHY WAITING IS THE WHOLE FIX. Measured on claude.ai from an empty partition: Cloudflare's
   * challenge resolved itself ~24 seconds after the first navigation and then went on to the real
   * page. Nothing was needed from the client — no cookie, no second navigation. The app was
   * failing only because it had no notion that this state is transient, so it stopped calling the
   * page loaded-but-empty and left the user staring at it.
   *
   * DELIBERATELY NOT RELOADING. A challenge is completed by JavaScript that is already running in
   * the page; navigating away restarts it from the beginning. The earlier instinct to "reload
   * until it passes" would therefore make it slower, not faster. This only watches.
   *
   * The poll is what makes it self-correcting: the interstitial's finish can arrive as a title
   * change, an in-page navigation or a full one, and `page-title-updated` alone is not dependable
   * on a page this minimal.
   */
  private beginBotCheckWait(contents: Electron.WebContents): void {
    if (this.botCheckSince === null) {
      this.botCheckSince = Date.now()
      // Push immediately so the UI can say what is happening instead of showing a dead page.
      this.publishState()
    }
    if (this.botCheckTimer !== null) return

    this.botCheckTimer = setInterval(() => {
      if (this.liveContents() !== contents || contents.isDestroyed()) {
        this.endBotCheckWait()
        return
      }
      const title = contents.getTitle()
      void contents
        .executeJavaScript('document.body ? document.body.innerText.slice(0, 300) : ""')
        .then((raw: unknown) => {
          const body = String(raw ?? '')
          if (!this.looksLikeBotCheck(title, body)) {
            const waited =
              this.botCheckSince === null ? 0 : Math.round((Date.now() - this.botCheckSince) / 1000)
            console.info(`[embed:${this.platform.id}] bot check cleared after ${waited}s`)
            this.endBotCheckWait()
          }
        })
        .catch(() => {
          /* a navigation during the read is normal; the next tick retries */
        })
    }, BOT_CHECK_POLL_MS)
  }

  private endBotCheckWait(): void {
    if (this.botCheckTimer !== null) {
      clearInterval(this.botCheckTimer)
      this.botCheckTimer = null
    }
    if (this.botCheckSince !== null) {
      this.botCheckSince = null
      this.lastLanding = ''
      this.publishState()
    }
  }

  /** A still picture of the page as shown now, for its slot while a dialog hides it; null when not on screen. */
  async captureSnapshot(): Promise<string | null> {
    const view = this.view
    if (!view || view.webContents.isDestroyed() || !this.visible || this.bounds.width < 1 || this.bounds.height < 1) return null
    try {
      const image = await view.webContents.capturePage()
      return image.isEmpty() ? null : 'data:image/jpeg;base64,' + image.toJPEG(85).toString('base64')
    } catch { return null }
  }

  setVisible(visible: boolean): void {
    this.visible = visible
    this.selectionQuestion?.setVisible(visible)
    if (!visible) this.selectionQuestion?.cancel()
    if (!visible) this.dismissSelectionQuestion()
    this.applyBounds()
  }

  getQuestionChatState(): QuestionChatState | null { return this.selectionQuestion?.getState() ?? null }
  createQuestionChat(): QuestionChatState | null { return this.selectionQuestion?.createChat() ?? null }
  /** @returns '' once the side chat is open, otherwise the message to show in the focus view. */
  askSelectionFromFocus(draft: Omit<SelectionQuestionDraft, 'sourcePath'>): Promise<string> {
    return this.selectionQuestion?.askFromFocus(draft) ?? Promise.resolve('当前页面暂不支持询问 AI，请稍后重试。')
  }
  setQuestionChatViewport(id: string, bounds: unknown, visible: boolean): void {
    // The owned side chat can remain visible beside an app-owned focus surface.
    // Session hiding still clears owner visibility through setVisible(false).
    if (visible && this.selectionQuestion?.getState()?.id === id) this.selectionQuestion.setVisible(true)
    this.selectionQuestion?.setViewport(id, bounds, visible)
  }
  questionChatAction(id: string, action: QuestionChatAction): void { this.selectionQuestion?.action(id, action) }

  /**
   * Reload the page.
   *
   * Needed after the proxy changes: connections already established keep using the
   * old route, so the page has to be fetched again through the new one.
   */
  reload(): void {
    this.liveContents()?.reload()
  }

  /**
   * Reload and resolve once the new document has finished loading.
   *
   * Needed after a session import: the cookie has to be in the jar before the page
   * asks who the user is, so the caller cannot simply fire `reload()` and check
   * immediately — it would inspect the OLD document and report a signed-out page for
   * a session that is actually valid.
   *
   * Resolves on timeout rather than rejecting: a page that never finishes loading
   * must not leave the settings dialog stuck, and the caller re-checks anyway.
   */
  async reloadAndWait(timeoutMs = 25000): Promise<void> {
    const contents = this.liveContents()
    if (!contents) return

    await new Promise<void>((resolve) => {
      let settled = false
      const finish = (): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        contents.removeListener('did-finish-load', finish)
        contents.removeListener('did-fail-load', finish)
        resolve()
      }
      const timer = setTimeout(finish, timeoutMs)

      contents.once('did-finish-load', finish)
      contents.once('did-fail-load', finish)
      contents.reload()
    })
  }

  /**
   * Point the view at a URL and resolve once it has loaded.
   *
   * Same contract as reloadAndWait, for the same reason.
   */
  async loadAndWait(url: string, timeoutMs = 25000): Promise<void> {
    const contents = this.liveContents()
    if (!contents) return

    await new Promise<void>((resolve) => {
      let settled = false
      const finish = (): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        contents.removeListener('did-finish-load', finish)
        contents.removeListener('did-fail-load', finish)
        resolve()
      }
      const timer = setTimeout(finish, timeoutMs)

      contents.once('did-finish-load', finish)
      contents.once('did-fail-load', finish)
      void contents.loadURL(url).catch(finish)
    })
  }

  command(command: EmbedCommand): void {
    const contents = this.liveContents()
    if (!contents) return

    const history = contents.navigationHistory
    switch (command) {
      case 'back':
        if (history.canGoBack()) history.goBack()
        break
      case 'forward':
        if (history.canGoForward()) history.goForward()
        break
      case 'reload':
        contents.reload()
        break
      case 'stop':
        contents.stop()
        break
      case 'home':
        void contents.loadURL(this.platform.homeUrl)
        break
    }
  }

  navigate(input: string): void {
    const contents = this.liveContents()
    const url = normalizeUrl(input)
    if (!contents || !url) return
    void contents.loadURL(url)
  }

  getInterceptorStatus(): InterceptorStatus {
    return {
      ...this.interceptor,
      pendingQuestion: this.interceptor.pendingQuestion
        ? {
            ...this.interceptor.pendingQuestion,
            questions: this.interceptor.pendingQuestion.questions.map((item) => ({ ...item }))
          }
        : null
    }
  }

  setTaskQuestionContext(messageId: string, owner: TaskQuestionRequest): void {
    this.taskQuestionContext = { messageId, owner: structuredClone(owner) }
    if (this.interceptor.pendingQuestion?.messageId === messageId) this.interceptor.pendingQuestion.taskContext = structuredClone(owner)
  }

  /** The page validates the question id again before touching the composer. */
  async answerQuestion(messageId: string, answer: string, source?: TaskQuestionSource): Promise<InterceptorStatus> {
    const rejection = (message: string, outcome: string): Error => Object.assign(new Error(message), { questionOutcome: outcome })
    if (this.interceptor.pendingQuestion?.messageId !== messageId) {
      throw rejection('这个问题已失效，请查看当前会话。', 'stale')
    }
    if (typeof answer !== 'string' || !answer.trim() || answer.length > 20000) {
      throw rejection('请输入回答（最多 20000 个字符）。', 'invalid-answer')
    }
    const contents = this.liveContents()
    if (!contents) throw rejection('模型页面尚未就绪，请稍后重试。', 'no-composer')
    if (source && (!this.taskQuestion || messageId !== this.taskQuestion.messageId || !sameQuestionSource(source, this.taskQuestion.source) ||
      source.pageEpoch !== this.computerPageEpoch || source.taskPromptGeneration !== this.taskPromptGeneration)) throw rejection('这个问题的页面上下文已失效，请查看原任务。', 'stale')
    const outcome: unknown = await contents.executeJavaScript(
      `window.__cmdTerminalInterceptor ? window.__cmdTerminalInterceptor.answerQuestion(${JSON.stringify(messageId)}, ${JSON.stringify(answer)}, ${JSON.stringify(source ?? null)}) : 'no-composer'`
    )
    console.info(`[embed:${this.platform.id}] question answer outcome=${String(outcome)} messageId=${messageId}`)
    if (outcome !== 'ok') {
      const messages: Record<string, string> = {
        busy: '模型仍在生成，或网页输入框已有内容。请稍后重试，或先处理网页中的草稿。',
        stuck: source ? '回答提交尚未确认，请核对原对话；任务内回答不会自动重发或视为授权。' : '回答已写入网页输入框，但尚未确认发送。可重试，或关闭弹框后在网页中手动发送。',
        'insert-failed': '回答未能写入网页输入框，请稍后重试。',
        stale: '这个问题已失效，请查看当前会话。',
        'invalid-answer': '请输入回答（最多 20000 个字符）。'
      }
      const error = new Error(messages[String(outcome)] ?? '模型页面尚未就绪，请稍后重试。') as Error & { questionOutcome?: string }
      error.questionOutcome = String(outcome); throw error
    }
    // Do not clear a newer question that may have arrived while this send was awaited.
    if (this.interceptor.pendingQuestion?.messageId === messageId) {
      this.interceptor.pendingQuestion = null
      this.handlers.onInterceptor(this.getInterceptorStatus())
    }
    return this.getInterceptorStatus()
  }

  /**
   * Ask a recorded question again. The page validates the JSON and reports it back as a live
   * `question`, which is what opens the app dialog; answering then works like the original.
   */
  async replayQuestion(messageId: string, payloadJson: string, source?: TaskQuestionSource): Promise<'ok' | 'busy' | 'invalid' | 'unavailable'> {
    const contents = this.liveContents()
    if (!contents) return 'unavailable'
    const outcome: unknown = await contents.executeJavaScript(
      `window.__cmdTerminalInterceptor && window.__cmdTerminalInterceptor.replayQuestion ? window.__cmdTerminalInterceptor.replayQuestion(${JSON.stringify(messageId)}, ${JSON.stringify(payloadJson)}, ${JSON.stringify(source ?? null)}) : 'unavailable'`
    ).catch(() => 'unavailable')
    console.info(`[embed:${this.platform.id}] question replay outcome=${String(outcome)} messageId=${messageId}`)
    if (outcome === 'ok' && source && (!this.taskQuestion || this.taskQuestion.messageId === messageId) && source.pageEpoch === this.computerPageEpoch) {
      this.taskQuestion = { messageId, source: structuredClone(source) }
      this.taskQuestionBindings?.set(messageId, structuredClone(source))
    }
    return outcome === 'ok' || outcome === 'busy' || outcome === 'invalid' ? outcome : 'unavailable'
  }

  /** Clear only this question and its owned draft; do not end the task or submit a message. */
  async cancelQuestion(messageId: string): Promise<InterceptorStatus> {
    if (this.interceptor.pendingQuestion?.messageId !== messageId) {
      throw new Error('这个问题已失效，请查看当前会话。')
    }
    const contents = this.liveContents()
    if (!contents) throw new Error('模型页面尚未就绪，请稍后重试。')
    const outcome: unknown = await contents.executeJavaScript(
      `window.__cmdTerminalInterceptor ? window.__cmdTerminalInterceptor.cancelQuestion(${JSON.stringify(messageId)}) : 'not-ready'`
    )
    if (outcome !== 'cancelled') {
      const messages: Record<string, string> = {
        stale: '这个问题已失效，请查看当前会话。',
        busy: '回答正在处理中，请稍后重试。',
        'draft-clear-failed': '未能清除网页中的回答草稿，请稍后重试。'
      }
      throw new Error(messages[String(outcome)] ?? '模型页面尚未就绪，请稍后重试。')
    }
    if (this.interceptor.pendingQuestion?.messageId === messageId) {
      this.interceptor.pendingQuestion = null
      this.handlers.onInterceptor(this.getInterceptorStatus())
    }
    return this.getInterceptorStatus()
  }

  /**
   * The live web contents, or null when the view is gone.
   *
   * Public because session import has to evaluate a probe inside the page, and
   * duplicating the "is it still alive" check at every call site is how one of them
   * eventually gets it wrong.
   */
  contents(): Electron.WebContents | null {
    return this.liveContents()
  }

  /** Keep the injected script's baseline policy in sync with the execution mode. */
  setBaselinePolicy(armOnInstall: boolean): void {
    this.armBaselineOnInstall = armOnInstall
  }

  /**
   * Turn terminal mode on/off. Always re-pushes the config into the live page so
   * the change takes effect immediately, without waiting for a reload.
   */
  setInterceptorEnabled(enabled: boolean): InterceptorStatus {
    this.interceptor.enabled = enabled
    // Terminal mode controls command execution, not an already-open question.
    void this.installInterceptor(false)
    const status = this.getInterceptorStatus()
    this.handlers.onInterceptor(status)
    return status
  }
  /** Prompt injection is independent of terminal execution and the active task. */
  setPromptInjectionEnabled(enabled: boolean): InterceptorStatus {
    if (this.interceptor.promptInjectionEnabled === enabled) return this.getInterceptorStatus()
    this.interceptor.promptInjectionEnabled = enabled
    void this.installInterceptor(false)
    const status = this.getInterceptorStatus()
    this.handlers.onInterceptor(status)
    return status
  }
  /** A history replay starts in the terminal before any message is sent to the page. */
  startTerminalTask(): void {
    this.interceptor.pendingQuestion = null
    this.interceptor.taskStartedAt = Date.now()
    this.interceptor.taskFinishedAt = null
    this.handlers.onInterceptor(this.getInterceptorStatus())
  }

  /** Mark the current task finished and publish the interceptor state. */
  completeTask(): InterceptorStatus {
    this.interceptor.commandRecovery = null
    this.resetTaskPrompt()
    this.interceptor.pendingQuestion = null
    if (this.interceptor.taskStartedAt !== null && this.interceptor.taskFinishedAt === null) {
      this.interceptor.taskFinishedAt = Date.now()
    }
    const status = this.getInterceptorStatus()
    this.handlers.onInterceptor(status)
    return status
  }
  /** A completed task or a different conversation needs a fresh prompt on its next send. */
  resetTaskPrompt(): void {
    this.taskQuestion = null
    this.taskQuestionBindings?.clear()
    this.taskQuestionContext = null
    this.interceptor.commandRecovery = null
    this.taskPromptInjected = false
    this.taskPromptGeneration += 1
    // Only update the prompt boundary: a fast next user send may already be awaiting
    // its reply when this configuration reaches the page.
    if (this.liveContents()) void this.installInterceptor(false)
  }
  setComputerUseRecognitionEnabled(enabled: boolean): void {
    if (this.computerUseRecognitionEnabled === enabled) return
    this.computerUseRecognitionEnabled = enabled
    if (this.liveContents()) void this.installInterceptor(false)
  }
  setSendBlock(message: string | null): void {
    if (this.sendBlock === message) return
    this.sendBlock = message
    if (this.liveContents()) void this.installInterceptor(false)
  }
  setComputerUseProtocolContext(context: { definitions: ComputerUseActionDefinition[]; stepToken: string | null }): void {
    if (JSON.stringify(this.computerUseProtocolContext) === JSON.stringify(context)) return
    this.computerUseProtocolContext = structuredClone(context)
    if (this.liveContents()) void this.installInterceptor(false)
  }
  /** Stop the page-side task loop and publish a finished task state immediately. */
  async endTask(): Promise<InterceptorStatus & { stopRequestAcknowledged: boolean }> {
    const contents = this.liveContents()
    // Revoke generation-bound sends and late page events before waiting for the renderer.
    const status = this.completeTask()
    const generation = this.taskPromptGeneration
    let stopRequestAcknowledged = !contents
    this.computerUseProtocolContext = { ...this.computerUseProtocolContext, stepToken: null }
    if (contents) {
      let timeout: ReturnType<typeof setTimeout> | undefined
      try {
        const acknowledged = await Promise.race([
          contents.executeJavaScript(`window.__cmdTerminalInterceptor ? window.__cmdTerminalInterceptor.endTask(${generation}) : false`),
          new Promise<never>((_resolve, reject) => { timeout = setTimeout(() => reject(new Error('page-stop-timeout')), 2000) })
        ])
        stopRequestAcknowledged = acknowledged === true
      } catch { console.warn('[embed] page stop acknowledgement unavailable; automatic task authority has been revoked') }
      finally { if (timeout) clearTimeout(timeout) }
    }
    return { ...status, stopRequestAcknowledged }
  }

  getComputerUsePageEpoch(): string { return this.computerPageEpoch }

  private invalidateComputerDocument(): void {
    this.computerPageEpoch = randomUUID()
    this.taskQuestion = null
    this.taskQuestionBindings?.clear()
    this.taskQuestionContext = null
    this.handlers.onComputerDocumentChanged?.()
  }

  /**
   * Inject the send interceptor into the page and push the current config.
   *
   * `executeJavaScript` is not subject to the page's CSP nonce (it does not go
   * through a script tag), and it runs in the main world — which is what the
   * page's own React handlers use, so our capture-phase listeners see the same
   * events they do.
   */
  async installInterceptor(armBaseline = this.armBaselineOnInstall): Promise<void> {
    const contents = this.liveContents()
    if (!contents) return

    const prefix = this.planPrefix(contents.getURL())
    if (prefix !== this.pushedPrefix) writeInjectionPlanDiagnostic(this.platform.id, this.injectionPlan, prefix.length)
    this.pushedPrefix = prefix
    const config = JSON.stringify({
      enabled: this.interceptor.enabled,
      promptInjectionEnabled: this.interceptor.promptInjectionEnabled,
      computerUseEnabled: this.platform.page.computerUseRequests === true && this.computerUseRecognitionEnabled,
      computerPageEpoch: this.computerPageEpoch,
      computerProtocol: this.computerUseProtocolContext,
      sendBlock: this.sendBlock,
      prefix,
      contextPrefixUsage: estimateContextText(prefix + '\u2063\u2063'),
      contextReminderUsage: estimateContextText(REPLY_PROTOCOL_REMINDER + '\u2063\u2063'),
      replyProtocolPrefix: REPLY_PROTOCOL_REMINDER,
      replyProtocolVersion: REPLY_PROTOCOL_VERSION,
      prefixIncludesReplyProtocol: prefix.includes(REPLY_PROTOCOL_SECTION),
      replyProtocolFullLength: REPLY_PROTOCOL_SECTION.length,
      taskPromptInjected: this.taskPromptInjected,
      toolPromptRevision: this.toolPromptRevision,
      taskPromptGeneration: this.taskPromptGeneration,
      // A full page (re)load must also suppress whatever it restores from
      // history, otherwise an old reply would look like a fresh command.
      armBaseline,
      // Which site's DOM to work against. The injected script is source text, so the
      // platform cannot be imported there — this is the only route it has.
      page: this.platform.page
    })

    try {
      await contents.executeJavaScript(
        `window.__computerUseProtocol = (${createComputerUseProtocol.toString()})();\n${interceptorSource}\n;` +
          `window.__cmdTerminalInterceptor && window.__cmdTerminalInterceptor.configure(${config});true`
      )
    } catch (error) {
      // A navigation during injection is normal; did-finish-load will retry.
      console.warn('[embed] interceptor injection failed:', (error as Error).message)
    }
  }

  /** The prefix for the next task start in the conversation at `url`; the full prompt when nothing plans. */
  private planPrefix(url: string): string {
    this.injectionPlan = this.handlers.planInjection?.(this.interceptor.prefix, conversationIdOf(this.platform, url)) ?? null
    const prefix = withReplyProtocol(this.injectionPlan ? this.injectionPlan.prefix : this.interceptor.prefix)
    // Commit the actual prefix (including a short contract on deltas/anchors), not an estimate.
    if (this.injectionPlan) this.injectionPlan = { ...this.injectionPlan, prefix }
    return prefix
  }

  /** The conversation's ledger changed: reconfigure the page only when its next prefix differs. */
  refreshInjectionPlan(): void {
    const contents = this.liveContents()
    if (contents && this.planPrefix(contents.getURL()) !== this.pushedPrefix) void this.installInterceptor(false)
  }

  /** Install the selection UI without exposing a page IPC bridge. */
  private async installSelectionQuestion(): Promise<void> {
    if (!supportsSelectionQuestion(this.platform.id)) return
    const contents = this.liveContents()
    if (!contents) return
    try {
      if (new URL(contents.getURL()).origin !== new URL(this.platform.homeUrl).origin) return
      const config = JSON.stringify({
        theme: this.theme,
        reportTag: this.selectionQuestion?.reportTag ?? '',
        // Gemini's measured assistant turn is already the answer root.
        answerSelectors: this.platform.page.assistantReplySelectors.length
          ? this.platform.page.assistantReplySelectors : this.platform.page.assistantSelectors,
        // Claude code-only replies can omit the answer font container. Only an
        // explicit assistant role may serve as the fallback, as in replyRootOf.
        answerFallbackSelectors: this.platform.page.assistantRoleSelectors ?? [],
        css: selectionQuestionCss
      })
      await contents.executeJavaScript(
        `${selectionQuestionSource}\n;window.__cmdTerminalSelectionQuestion.configure(${config});true`
      )
    } catch (error) {
      writeQuestionLog('QUESTION-UI-INSTALL-ERROR', { platformId: this.platform.id })
      console.warn(`[embed:${this.platform.id}] selection question injection failed:`, (error as Error).message)
    }
  }

  private dismissSelectionQuestion(): void {
    if (!supportsSelectionQuestion(this.platform.id)) return
    const contents = this.liveContents()
    if (!contents) return
    void contents.executeJavaScript('window.__cmdTerminalSelectionQuestion?.dismiss();true').catch(() => {
      /* The view may be navigating or closing. Its old document no longer owns a popup. */
    })
  }

  /**
   * Inject the theme script independently of the command protocol and selection UI.
   * These source-text rules can be empty on platforms whose theme is unmeasured.
   */
  async installTheme(): Promise<void> {
    const contents = this.liveContents()
    if (!contents) return

    const rules = this.platform.page.theme
    const config = JSON.stringify({
      theme: this.theme,
      dark: rules?.dark ?? [],
      light: rules?.light ?? [],
      storage: rules?.storage ?? []
    })

    try {
      await contents.executeJavaScript(
        `${themeSource}\n;` +
          `window.__cmdTerminalTheme && window.__cmdTerminalTheme.configure(${config});true`
      )
    } catch (error) {
      // A navigation during injection is normal; dom-ready / did-finish-load will retry.
      console.warn(`[embed:${this.platform.id}] theme injection failed:`, (error as Error).message)
    }
  }

  /**
   * Push command output into the composer and submit it, deliberately WITHOUT
   * the system prompt: the prompt is already established by the first user message
   * of the task, and re-sending it every round would bloat the context.
   *
   * `busy` means a send/generation is in progress or a user draft exists.
   * `stuck` means the text went in but the page never accepted the submit.
   */
  /** The focus view acts only on its own platform's site, never a page that navigated elsewhere. */
  private focusPage(): Electron.WebContents | null {
    const contents = this.liveContents()
    if (!contents || !supportsFocusView(this.platform.id)) return null
    try {
      return new URL(contents.getURL()).origin === new URL(this.platform.homeUrl).origin ? contents : null
    } catch { return null }
  }

  async readFocusSnapshot(): Promise<FocusPageSnapshot | null> {
    this.hiddenViewProbe?.active()
    const contents = this.focusPage()
    if (!contents) return null
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const url = contents.getURL()
      const raw = await Promise.race([
        contents.executeJavaScript('window.__cmdTerminalInterceptor?.focusSnapshot() ?? null'),
        new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), 2500) })
      ]) as FocusPageSnapshot | null
      if (!raw || contents.isDestroyed() || contents.getURL() !== url || raw.path !== new URL(url).pathname ||
        typeof raw.ready !== 'boolean' || typeof raw.nativeDraft !== 'boolean' || typeof raw.waiting !== 'boolean' ||
        !['active', 'idle', 'unknown'].includes(raw.generating)) return null
      if (raw.reply && (typeof raw.reply.sourceMessageId !== 'string' || raw.reply.sourceMessageId.length > 512 ||
        typeof raw.reply.answer !== 'string' || raw.reply.answer.length > 250000 || !Array.isArray(raw.reply.parts) ||
        raw.reply.parts.length > 50 || raw.reply.parts.some(part => !part || !['reasoning', 'search'].includes(part.kind) ||
          typeof part.text !== 'string' || part.text.length > 50000 ||
          (part.url !== undefined && (typeof part.url !== 'string' || !/^https?:\/\//.test(part.url) || part.url.length > 2000))))) return null
      if (raw.smartReplies !== undefined && (!Array.isArray(raw.smartReplies) || raw.smartReplies.length > 8 || raw.smartReplies.some(reply =>
        !reply || typeof reply.sourceMessageId !== 'string' || reply.sourceMessageId.length > 160 || typeof reply.answer !== 'string' || reply.answer.length > 250000))) return null
      if (raw.composerModes !== undefined && !validFocusComposerModes(raw.composerModes)) return null
      if (raw.modelSettings !== undefined && !validFocusModelSettings(raw.modelSettings)) return null
      if (raw.modelSettingsReady !== undefined && typeof raw.modelSettingsReady !== 'boolean') return null
      if (raw.sendFailure != null && !validFocusSendFailure(raw.sendFailure)) return null
      this.hiddenViewProbe?.active(raw.waiting && !raw.reply && !raw.sendFailure)
      return raw
    } catch { return null }
    finally { if (timer) clearTimeout(timer) }
  }

  async retryFocusSend(failureId: string, owns: () => boolean = () => true): Promise<FocusSendOutcome> {
    const contents = this.focusPage()
    if (!owns() || !contents || !this.platform.page.focus?.sendFailure || this.focusEditToken) return 'unavailable'
    const token = randomUUID(), url = contents.getURL()
    const current = (): boolean => owns() && !contents.isDestroyed() && contents.getURL() === url && this.focusEditToken === token
    this.focusEditToken = token
    let dispatched = false
    try {
      const point = await contents.executeJavaScript('window.__cmdTerminalInterceptor?.prepareFocusSendRetry(' +
        JSON.stringify(failureId) + ',' + JSON.stringify(new URL(url).pathname) + ',' + JSON.stringify(token) + ')')
      if (!current()) return 'cancelled'
      if (!point?.ok) return point?.outcome === 'busy' ? 'busy' : 'unavailable'
      const focused = !!this.view && (BrowserWindow.getFocusedWindow()?.contentView.children.includes(this.view) ?? false)
      const zoom = contents.getZoomFactor()
      if (!focused || ![point.x, point.y, zoom].every(value => typeof value === 'number' && Number.isFinite(value) && value >= 0) ||
        zoom <= 0 || point.x * zoom > 100000 || point.y * zoom > 100000) return 'unavailable'
      const position = { x: Math.round(point.x * zoom), y: Math.round(point.y * zoom) }
      contents.sendInputEvent({ type: 'mouseMove', ...position })
      contents.sendInputEvent({ type: 'mouseDown', ...position, button: 'left', clickCount: 1 })
      contents.sendInputEvent({ type: 'mouseUp', ...position, button: 'left', clickCount: 1 })
      dispatched = true
      const result = await contents.executeJavaScript('window.__cmdTerminalInterceptor?.finishFocusSendRetry(' + JSON.stringify(token) + ',true)')
      if (!current()) return 'cancelled'
      return ['ok', 'busy', 'stuck', 'unknown', 'cancelled', 'unavailable'].includes(result) ? result : 'unknown'
    } catch { return dispatched ? 'unknown' : 'unavailable' }
    finally {
      if (!contents.isDestroyed()) await contents.executeJavaScript('window.__cmdTerminalInterceptor?.finishFocusSendRetry(' + JSON.stringify(token) + ',false)').catch(() => {})
      if (this.focusEditToken === token) this.focusEditToken = null
    }
  }

  async setFocusComposerMode(id: 'thinking' | 'search', active: boolean): Promise<FocusSendOutcome> {
    const contents = this.focusPage()
    if (!contents || this.platform.id !== 'deepseek' || this.focusEditToken) return 'unavailable'
    const url = contents.getURL()
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const result = await Promise.race([
        contents.executeJavaScript('window.__cmdTerminalInterceptor?.setComposerMode(' + JSON.stringify(id) + ',' +
          JSON.stringify(active) + ',' + JSON.stringify(new URL(url).pathname) + ') ?? "unavailable"'),
        new Promise<string>(resolve => { timer = setTimeout(() => resolve('unknown'), 3500) })
      ])
      if (contents.isDestroyed() || contents.getURL() !== url) return 'cancelled'
      return ['ok', 'busy', 'unavailable', 'invalid', 'unknown', 'cancelled'].includes(result) ? result : 'unknown'
    } catch { return 'unknown' }
    finally { if (timer) clearTimeout(timer) }
  }

  private focusModelNativeClick: { token: string; dispatch(step: number): void } | null = null
  async updateFocusModelSettings(request: FocusModelSettingsRequest, token: string, owns: () => boolean): Promise<FocusModelSettingsResult> {
    const contents = this.focusPage()
    if (!contents || this.platform.id !== 'chatgpt' || this.focusEditToken || this.focusModelNativeClick) return { outcome: 'unavailable', settings: null }
    const url = contents.getURL()
    const route = new URL(url)
    let timer: ReturnType<typeof setTimeout> | undefined, step = 0
    const current = (): boolean => {
      if (!owns() || contents.isDestroyed() || this.focusModelNativeClick?.token !== token) return false
      try {
        const live = new URL(contents.getURL())
        // A model choice may update the query string while retaining the same chat.
        return live.origin === route.origin && live.pathname === route.pathname
      } catch { return false }
    }
    this.focusModelNativeClick = { token, dispatch: next => {
      if (!current() || !Number.isSafeInteger(next) || next !== step + 1 || next > 5) return
      step = next
      void dispatchFocusModelClick(contents, token, next, current,
        () => !!this.view && (BrowserWindow.getFocusedWindow()?.contentView.children.includes(this.view) ?? false))
    } }
    try {
      const raw = await Promise.race([
        contents.executeJavaScript('window.__cmdTerminalInterceptor?.updateModelSettings(' + JSON.stringify(request.kind) + ',' +
          JSON.stringify(request.value ?? null) + ',' + JSON.stringify(new URL(url).pathname) + ',' + JSON.stringify(token) + ')'),
        new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), 9500) })
      ])
      if (!current()) return { outcome: 'cancelled', settings: null }
      if (!raw || !['ok', 'busy', 'unavailable', 'invalid', 'unknown', 'cancelled'].includes(raw.outcome) ||
        !validFocusModelSettings(raw.settings)) return { outcome: 'unknown', settings: null }
      return { outcome: raw.outcome, settings: raw.settings,
        ...(typeof raw.reason === 'string' && /^[a-z-]{1,60}$/.test(raw.reason) ? { reason: raw.reason } : {}) }
    } catch { return { outcome: 'unknown', settings: null, reason: 'page-exception' } }
    finally { if (timer) clearTimeout(timer); if (this.focusModelNativeClick?.token === token) this.focusModelNativeClick = null }
  }

  async sendFocusUser(text: string): Promise<FocusSendOutcome> {
    if (!supportsFocusView(this.platform.id)) return 'unavailable'
    return this.sendUserTask(text, false, { fromFocus: true })
  }

  /** Press only this page's native Stop control; terminal task cancellation is separate. */
  async stopFocusGeneration(): Promise<FocusSendOutcome> {
    const contents = this.focusPage()
    if (!contents) return 'unavailable'
    let clicked = false
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const deadline = new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), 6500) })
      const url = contents.getURL(), path = new URL(url).pathname
      const point = await Promise.race([contents.executeJavaScript('window.__cmdTerminalInterceptor?.prepareFocusStop(' + JSON.stringify(path) + ')'), deadline])
      if (contents.isDestroyed() || contents.getURL() !== url) return 'cancelled'
      if (point?.outcome !== 'ok') return 'unavailable'
      if (point.x === undefined && point.y === undefined) return 'ok'
      if (!Number.isFinite(point.x) || !Number.isFinite(point.y) || !Number.isSafeInteger(point.generation)) return 'unavailable'
      this.clickAt(point.x, point.y)
      clicked = true
      const outcome = await Promise.race([contents.executeJavaScript('window.__cmdTerminalInterceptor?.finishFocusStop(' + JSON.stringify(path) + ',' + point.generation + ')'), deadline])
      if (contents.isDestroyed() || contents.getURL() !== url) return 'cancelled'
      return ['ok', 'cancelled', 'unknown'].includes(outcome) ? outcome : 'unknown'
    } catch { return clicked ? 'unknown' : 'unavailable' }
    finally { if (timer) clearTimeout(timer) }
  }

  private focusEditToken: string | null = null
  async readFocusUiRecovery(sourceIds: string[]): Promise<FocusUiRecovery | null> {
    const contents = this.focusPage()
    if (!contents || this.platform.id !== 'chatgpt' || this.focusEditToken || !sourceIds.length) return null
    try {
      const url = contents.getURL(), path = new URL(url).pathname
      const value = await contents.executeJavaScript('window.__cmdTerminalInterceptor?.readSmartUiRecovery(' + JSON.stringify(sourceIds.slice(-200)) + ',' + JSON.stringify(path) + ')')
      if (contents.isDestroyed() || contents.getURL() !== url || !value || !sourceIds.includes(value.sourceMessageId) ||
        typeof value.userMessageId !== 'string' || !/^[a-zA-Z0-9_:-]{1,160}$/.test(value.userMessageId) ||
        typeof value.userText !== 'string' || !value.userText.trim() || value.userText.length > 20000) return null
      return value
    } catch { return null }
  }
  async adoptFocusUiRecovery(recovery: FocusUiRecovery): Promise<boolean> {
    const contents = this.focusPage()
    if (!contents || this.platform.id !== 'chatgpt' || this.focusEditToken) return false
    try {
      const url = contents.getURL()
      const adopted = await contents.executeJavaScript('window.__cmdTerminalInterceptor?.adoptSmartUiRecovery(' + JSON.stringify(recovery) + ',' + JSON.stringify(new URL(url).pathname) + ')')
      return !contents.isDestroyed() && contents.getURL() === url && adopted === true
    } catch { return false }
  }
  private focusUiNativeClick: { token: string; dispatch(): void } | null = null
  async actOnFocusUi(request: FocusUiAction & { token: string }, diagnose: (details: FocusEditDiagnostic) => void): Promise<FocusSendOutcome> {
    const contents = this.focusPage(), rules = this.platform.page.focus?.smartUi
    if (!contents || !rules || this.focusEditToken) {
      diagnose({ stage: 'prepare', reason: !contents ? 'page-unavailable' : !rules ? 'rules-missing' : 'edit-in-progress' })
      return 'unavailable'
    }
    this.focusEditToken = request.token
    let stopObserving: (() => void) | undefined
    try {
      const url = new URL(contents.getURL()), conversationId = this.platform.conversationIdFromPath(url.pathname)
      if (!conversationId) return 'unavailable'
      let clickHandled = false, requestCount = 0
      const current = (): boolean => !contents.isDestroyed() && contents.getURL() === url.href && this.focusEditToken === request.token
      this.focusUiNativeClick = { token: request.token, dispatch: () => {
        if (clickHandled || !current()) return
        clickHandled = true
        void dispatchFocusUiClick(contents, request.token, current,
          () => !!this.view && (BrowserWindow.getFocusedWindow()?.contentView.children.includes(this.view) ?? false), diagnose)
      } }
      if (request.kind === 'submit') stopObserving = observeFocusPageRequest(contents, url.origin, details => {
        if (!current() || details.method !== 'POST') return
        const summary = smartUiSubmission(details, { origin: url.origin, path: rules.submissionPath, conversationId,
          sourceMessageId: request.sourceMessageId, selectedValue: request.selectedValue })
        diagnose({ stage: 'request', reason: summary?.reason ?? 'request-unrelated', requestCount: ++requestCount,
          requestPathMatches: new URL(details.url).pathname === rules.submissionPath,
          ...(summary ? { requestStateMatches: summary.requestStateMatches, requestStatePresent: summary.requestStatePresent,
            requestSnapshotCount: summary.requestSnapshotCount, submitted: true } : {}) })
        if (!summary) return
        void contents.executeJavaScript('window.__cmdTerminalInterceptor?.noteSmartUiSubmission(' + JSON.stringify(request.token) + ',' + JSON.stringify(summary) + ')').catch(() => {})
      })
      const raw = await contents.executeJavaScript('(async () => {' +
        'const api = window.__cmdTerminalInterceptor;' +
        'return typeof api?.smartUiAction === "function" && typeof api?.noteSmartUiSubmission === "function" && typeof api?.prepareSmartUiClick === "function" ? ' +
        'await api.smartUiAction(' + JSON.stringify(request) + ',' + JSON.stringify(url.pathname) + ') : {outcome:"unavailable",diagnostic:{stage:"prepare",reason:"api-missing"}}' +
        '})()')
      if (raw?.diagnostic && typeof raw.diagnostic === 'object') diagnose({ ...raw.diagnostic, requestCount })
      const outcome = typeof raw === 'string' ? raw : raw?.outcome
      return ['ok', 'busy', 'stuck', 'unavailable', 'no-composer', 'invalid', 'cancelled'].includes(outcome) ? outcome : 'unavailable'
    } catch { diagnose({ stage: 'prepare', reason: 'page-exception' }); return 'stuck' }
    finally {
      stopObserving?.()
      if (this.focusUiNativeClick?.token === request.token) this.focusUiNativeClick = null
      if (this.focusEditToken === request.token) this.focusEditToken = null
    }
  }

  async editFocusUser(request: { token: string; originalText: string; text: string; replyMessageId: string | null },
    diagnose: (details: FocusEditDiagnostic) => void = () => {}): Promise<FocusSendOutcome> {
    const contents = this.focusPage()
    if (!contents || !this.platform.page.focus?.edit || this.focusEditToken) {
      diagnose({ stage: 'prepare', reason: !contents ? 'page-unavailable' : !this.platform.page.focus?.edit ? 'rules-missing' : 'edit-in-progress' })
      return 'unavailable'
    }
    this.focusEditToken = request.token
    let stopObserving: (() => void) | undefined
    try {
      const url = new URL(contents.getURL())
      const path = url.pathname
      const conversationId = this.platform.conversationIdFromPath(path)
      if (!conversationId) return 'unavailable'
      // The edit drops every later turn; the page must hold the full prompt before it resends.
      this.handlers.onConversationBranched?.(conversationId)
      if (this.planPrefix(contents.getURL()) !== this.pushedPrefix) await this.installInterceptor(false)
      stopObserving = observeFocusEditRequest(contents, {
        origin: url.origin, submissionPath: this.platform.page.focus.edit.submissionPath,
        conversationId, text: request.text, originalText: request.originalText, prefix: this.pushedPrefix ?? this.interceptor.prefix
      }, submission => {
        const { messageId: _messageId, ...diagnostic } = submission
        diagnose({ ...diagnostic, stage: 'request' })
        if (contents.isDestroyed() || this.focusEditToken !== request.token || contents.getURL() !== url.href) return
        void contents.executeJavaScript('window.__cmdTerminalInterceptor?.noteEditSubmission(' +
          JSON.stringify(request.token) + ',' + JSON.stringify(submission) + ')').catch(() => {})
      })
      const raw = await contents.executeJavaScript('(async () => {' +
        'const api = window.__cmdTerminalInterceptor;' +
        'return typeof api?.editUser === "function" && typeof api?.noteEditSubmission === "function" ? await api.editUser(' + JSON.stringify(request) + ', ' + JSON.stringify(path) + ')' +
        ': {outcome:"unavailable",diagnostic:{stage:"prepare",reason:"api-missing"}}' +
        '})()')
      if (raw?.diagnostic && typeof raw.diagnostic === 'object') diagnose(raw.diagnostic)
      const result = typeof raw === 'string' ? raw : raw?.outcome
      if (!['ok', 'busy', 'stuck', 'no-composer', 'insert-failed', 'unavailable', 'invalid', 'cancelled'].includes(result)) {
        diagnose({ stage: 'prepare', reason: 'invalid-result' })
      }
      return ['ok', 'busy', 'stuck', 'no-composer', 'insert-failed', 'unavailable', 'invalid', 'cancelled'].includes(result) ? result : 'unavailable'
    } catch { diagnose({ stage: 'prepare', reason: 'page-exception' }); return 'stuck' }
    finally {
      stopObserving?.()
      if (this.focusEditToken === request.token) this.focusEditToken = null
    }
  }

  /** Sidebar user tasks share the confirmed send path on every supported platform. */
  /** Why the page refused the last human-task send (raw-busy reason), or null. */
  async userSendBlockReason(): Promise<string | null> {
    const contents = this.liveContents()
    if (!contents) return null
    try {
      const reason: unknown = await contents.executeJavaScript('window.__cmdTerminalInterceptor?.userSendBlock?.() ?? null')
      return typeof reason === 'string' && /^[a-z-]{1,40}$/.test(reason) ? reason : null
    } catch { return null }
  }

  /** force: an explicit 继续原任务 — the page stops a streaming reply and ends a stale wait first. */
  async sendUserTask(text: string, force = false, options?: { fromFocus: boolean }): Promise<FocusSendOutcome> {
    const contents = this.liveContents()
    if (!contents) return 'unavailable'
    let attempted = false
    try {
      const url = new URL(contents.getURL())
      if (url.origin !== new URL(this.platform.homeUrl).origin) return 'unavailable'
      attempted = true
      const sendOptions = { ...(force ? { force: true } : {}), ...(options?.fromFocus ? { fromFocus: true } : {}) }
      const result = await contents.executeJavaScript(
        'window.__cmdTerminalInterceptor?.sendUser(' + JSON.stringify(text) + ', ' + JSON.stringify(url.pathname) + (Object.keys(sendOptions).length ? ', ' + JSON.stringify(sendOptions) : '') + ') ?? "unavailable"'
      )
      return ['ok', 'busy', 'stuck', 'no-composer', 'insert-failed', 'unavailable', 'invalid'].includes(result) ? result : 'stuck'
    } catch { return attempted ? 'stuck' : 'unavailable' }
  }

  /** A dialog approval belongs to one live target, including throughout page-side retries. */
  async sendScopedUserTask(text: string, signal: AbortSignal, isCurrent: () => boolean): Promise<FocusSendOutcome> {
    const contents = this.liveContents()
    if (!contents) return 'unavailable'
    const token = randomUUID(), generation = this.taskPromptGeneration, epoch = this.computerPageEpoch
    const current = (): boolean => !signal.aborted && isCurrent() && !contents.isDestroyed() &&
      generation === this.taskPromptGeneration && epoch === this.computerPageEpoch
    const cancel = (): void => {
      if (!contents.isDestroyed()) void contents.executeJavaScript(
        `window.__cmdTerminalInterceptor?.cancelScopedUser(${JSON.stringify(token)})`).catch(() => {})
    }
    signal.addEventListener('abort', cancel, { once: true })
    let attempted = false
    try {
      if (!current()) return 'cancelled'
      const url = new URL(contents.getURL())
      if (url.origin !== new URL(this.platform.homeUrl).origin) return 'unavailable'
      const allowNewConversation = this.platform.conversationIdFromPath(url.pathname) === null
      attempted = true
      const outcome: unknown = await contents.executeJavaScript(
        `window.__cmdTerminalInterceptor?.sendScopedUser(${JSON.stringify(text)},${JSON.stringify(url.pathname)},${JSON.stringify(token)},${allowNewConversation}) ?? 'unavailable'`)
      if (outcome === 'cancelled') return 'cancelled'
      if (!current()) return 'unknown'
      return ['ok', 'busy', 'stuck', 'no-composer', 'insert-failed', 'unavailable', 'invalid'].includes(String(outcome)) ? outcome as FocusSendOutcome : 'unknown'
    } catch { return attempted ? 'unknown' : 'cancelled' }
    finally { signal.removeEventListener('abort', cancel) }
  }

  /** A scheduled goal follows the user-task pipeline, with its own cancellable submission identity. */
  async sendScheduledUser(text: string, conversationId: string, runId: string, signal: AbortSignal, isCurrent: () => boolean): Promise<FocusSendOutcome> {
    const contents = this.liveContents()
    if (!contents) return 'unavailable'
    const generation = this.taskPromptGeneration, epoch = this.computerPageEpoch
    const current = (): boolean => {
      if (signal.aborted || !isCurrent() || contents.isDestroyed() || generation !== this.taskPromptGeneration || epoch !== this.computerPageEpoch) return false
      try {
        const url = new URL(contents.getURL())
        return url.origin === new URL(this.platform.homeUrl).origin && this.platform.conversationIdFromPath(url.pathname) === conversationId
      } catch { return false }
    }
    if (!current()) return 'cancelled'
    const token = 'scheduled:' + runId
    const cancel = (): void => {
      if (!contents.isDestroyed()) void contents.executeJavaScript(`window.__cmdTerminalInterceptor?.cancelComputerResult(${JSON.stringify(token)})`).catch(() => {})
    }
    signal.addEventListener('abort', cancel, { once: true })
    let attempted = false
    try {
      if (!current()) return 'cancelled'
      const path = new URL(contents.getURL()).pathname
      // A planned prefix already reflects what the conversation holds; the flag is the fallback without one.
      const conversationPromptInjected = !this.injectionPlan && this.handlers.hasConversationPrompt?.(conversationId) === true
      attempted = true
      const result: unknown = await contents.executeJavaScript(
        `window.__cmdTerminalInterceptor?.sendScheduledUser(${JSON.stringify(text)},${JSON.stringify(path)},${JSON.stringify(runId)},${conversationPromptInjected}) ?? 'unavailable'`)
      if (result === 'ok') return 'ok'
      if (!current()) return 'unknown'
      return ['busy', 'no-composer', 'unavailable', 'invalid', 'insert-failed'].includes(String(result)) ? result as FocusSendOutcome : 'unknown'
    } catch { return attempted ? 'unknown' : 'cancelled' }
    finally { signal.removeEventListener('abort', cancel) }
  }

  async sendFocusFiles(text: string, files: PreparedAttachment[], token: string, current: () => boolean, signal: AbortSignal,
    images: ConversationImageAttachmentInput[] = []): Promise<FocusSendOutcome> {
    const contents = this.focusPage()
    if (!contents) return 'unavailable'
    try {
      this.focusSendImages.set(token, images)
      const outcome = await sendPageFiles(contents, this.platform.id, files, token, current, signal, { userText: text, allowNewConversation: true })
      if (outcome === 'ok') this.noteAttachmentTraffic(files)
      return outcome === 'not-submitted' ? 'upload-failed' : outcome
    } catch { return 'upload-failed' }
    finally { this.focusSendImages.delete(token) }
  }

  async sendRaw(
    text: string,
    options?: { conversationId: string; requireIdle: boolean }
  ): Promise<'ok' | 'busy' | 'stuck' | 'no-composer' | 'insert-failed'> {
    const contents = this.liveContents()
    if (!contents) return 'no-composer'
    const usage = this.contextUsage?.begin(text, 'tool-result')
    let usageOutcome: unknown = 'not-sent'

    try {
      const path = new URL(contents.getURL()).pathname
      if (options && this.platform.conversationIdFromPath(path) !== options.conversationId) return 'busy'
      usageOutcome = 'unknown'
      const outcome = (await contents.executeJavaScript(
        `window.__cmdTerminalInterceptor
           ? window.__cmdTerminalInterceptor.sendRaw(${JSON.stringify(text)}, null, ${JSON.stringify(options ? { requireIdle: options.requireIdle, path } : null)})
           : 'no-composer'`
      )) as unknown
      usageOutcome = ['ok', 'busy', 'stuck', 'no-composer', 'insert-failed'].includes(String(outcome)) ? outcome : 'unknown'

      if (
        outcome === 'ok' ||
        outcome === 'busy' ||
        outcome === 'stuck' ||
        outcome === 'insert-failed'
      ) {
        return outcome
      }
      return 'no-composer'
    } catch (error) {
      console.warn('[embed] sendRaw failed:', (error as Error).message)
      return 'no-composer'
    } finally { this.contextUsage?.finish(usage, usageOutcome) }
  }

  /** Strict outcome semantics for automatic desktop results; legacy sendRaw stays unchanged. */
  async sendTaskObservation(text: string, conversationId: string, signal: AbortSignal, attachments: PreparedAttachment[], imageId: string, isCurrent: () => boolean): Promise<TaskResultSendOutcome> {
    const contents = this.liveContents()
    if (!contents) return 'no-composer'
    if (this.platform.page.computerUseRequests !== true || attachments.length !== 1) return 'unknown'
    const generation = this.taskPromptGeneration
    const pageEpoch = this.computerPageEpoch
    const current = (): boolean => {
      if (signal.aborted || !isCurrent() || contents.isDestroyed() || generation !== this.taskPromptGeneration || pageEpoch !== this.computerPageEpoch) return false
      try {
        const url = new URL(contents.getURL())
        return url.origin === new URL(this.platform.homeUrl).origin && this.platform.conversationIdFromPath(url.pathname) === conversationId
      } catch { return false }
    }
    if (!current()) return 'stale'
    const usage = this.contextUsage?.begin(text, 'tool-result', 'observation:' + imageId, { images: 1, files: 0 })
    let outcome: import('../shared/file-requests').FileSendOutcome = 'unknown'
    try { outcome = await sendPageFiles(contents, this.platform.id, attachments, 'computer-image:' + imageId, current, signal,
      { caption: text, computerResult: { path: new URL(contents.getURL()).pathname, generation } }) }
    finally { this.contextUsage?.finish(usage, outcome) }
    if (outcome === 'ok') return 'ok'
    if (signal.aborted || !current()) return 'stale'
    if (outcome === 'not-submitted' || outcome === 'insert-failed' || outcome === 'unsupported-file-type') return 'failed'
    return outcome === 'busy' || outcome === 'no-composer' ? outcome : 'unknown'
  }

  async sendTaskResult(text: string, conversationId: string, signal: AbortSignal, isCurrent: () => boolean = () => true): Promise<Exclude<TaskResultSendOutcome, 'failed'>> {
    const contents = this.liveContents()
    if (!contents) return 'no-composer'
    const generation = this.taskPromptGeneration, pageEpoch = this.computerPageEpoch
    const current = (): boolean => {
      if (signal.aborted || !isCurrent() || contents.isDestroyed() || generation !== this.taskPromptGeneration || pageEpoch !== this.computerPageEpoch) return false
      try {
        const url = new URL(contents.getURL())
        return url.origin === new URL(this.platform.homeUrl).origin && this.platform.conversationIdFromPath(url.pathname) === conversationId
      } catch { return false }
    }
    if (!current()) return 'stale'
    const token = `computer-result:${Date.now()}:${Math.random().toString(36).slice(2)}`
    const cancel = (): void => {
      if (!contents.isDestroyed()) void contents.executeJavaScript(
        `window.__cmdTerminalInterceptor?.cancelComputerResult(${JSON.stringify(token)})`).catch(() => {})
    }
    signal.addEventListener('abort', cancel, { once: true })
    const usage = this.contextUsage?.begin(text, 'tool-result')
    let usageOutcome: unknown = 'not-sent'
    try {
      const path = new URL(contents.getURL()).pathname
      if (!current()) return 'stale'
      const options = { path, generation, requireIdle: true, computerResultToken: token }
      usageOutcome = 'unknown'
      const outcome: unknown = await contents.executeJavaScript(
        `window.__cmdTerminalInterceptor?.sendComputerResult
          ? window.__cmdTerminalInterceptor.sendComputerResult(${JSON.stringify(text)}, ${JSON.stringify(options)})
          : 'no-composer'`)
      usageOutcome = ['ok', 'busy', 'stuck', 'no-composer', 'insert-failed'].includes(String(outcome)) ? outcome : 'unknown'
      if (!current()) return 'stale'
      if (outcome === 'ok' || outcome === 'busy' || outcome === 'no-composer' || outcome === 'stuck' || outcome === 'insert-failed') return outcome
      return 'unknown'
    } catch {
      // IPC/navigation can fail after clicking Send. It is unsafe to assume nothing was sent.
      return !current() ? 'stale' : 'unknown'
    } finally { signal.removeEventListener('abort', cancel); this.contextUsage?.finish(usage, usageOutcome) }
  }

  /** Page-side token, generation and path checks pin this to one unexecuted reply. */
  async recoverCommand(allowSend: boolean, manual = false): Promise<string> {
    const recovery = this.interceptor.commandRecovery
    const contents = this.liveContents()
    if (!recovery || !contents) return 'stale'
    const stillPending = (): boolean => {
      const current = this.interceptor.commandRecovery
      return current?.token === recovery.token && current.generation === recovery.generation &&
        current.messageId === recovery.messageId && current.status === 'pending'
    }
    try {
      const result = String(await contents.executeJavaScript(
        `window.__cmdTerminalInterceptor?.recoverCommand(${recovery.token}, ${recovery.generation}, ${allowSend}, ${manual}, ${JSON.stringify(recovery.messageId)}) ?? 'stale'`))
      if (stillPending()) {
        const status = result === 'ok' ? 'sent' : result === 'limit' ? 'failed'
          : ['busy', 'no-composer', 'stale'].includes(result) ? 'blocked' : 'uncertain'
        this.setCommandRecovery({ ...recovery, status })
      }
      return result
    } catch {
      if (stillPending()) {
        this.setCommandRecovery({ ...recovery, status: 'uncertain' })
      }
      return 'stuck'
    }
  }

  private setCommandRecovery(recovery: Omit<CommandRecoveryState, 'message'> & { message?: string }): void {
    const messages: Record<CommandRecoveryState['status'], string> = {
      pending: '指令未执行，正在请求 AI 修正格式…', sent: '已通知 AI 修正指令，等待新回复…',
      blocked: '指令未执行。请处理网页草稿或恢复自动执行后重试修正。',
      failed: '修正后的指令仍无法识别，已停止自动重试。',
      uncertain: '修正请求是否发送成功尚未确认，请先在原始视图核对。'
    }
    this.interceptor.commandRecovery = { ...recovery, message: messages[recovery.status] }
    this.handlers.onCommandRecovery?.(this.interceptor.commandRecovery)
    this.handlers.onInterceptor(this.getInterceptorStatus())
  }

  async sendFileResult(result: PreparedFileResult, token: string, current: () => boolean, signal: AbortSignal): Promise<FileSendOutcome> {
    const contents = this.liveContents()
    const platform = fileReadingPlatform(this.platform.id)
    if (!contents || !platform) return 'no-composer'
    const guard = (): boolean => {
      if (!current() || contents.isDestroyed()) return false
      try { return new URL(contents.getURL()).origin === new URL(this.platform.homeUrl).origin } catch { return false }
    }
    if (!guard()) return 'cancelled'
    const usage = this.contextUsage?.begin('', 'attachment', token, {
      images: result.attachments.filter(file => file.mimeType.startsWith('image/')).length,
      files: result.attachments.filter(file => !file.mimeType.startsWith('image/')).length })
    let outcome: FileSendOutcome = 'unknown'
    try { outcome = await sendPageFiles(contents, platform.id, result.attachments, token, guard, signal) }
    finally { this.contextUsage?.finish(usage, outcome) }
    if (outcome === 'ok') this.noteAttachmentTraffic(result.attachments)
    return outcome
  }

  /** Text files count by size (about two bytes a character); an image counts as a fixed amount. */
  private noteAttachmentTraffic(attachments: PreparedAttachment[]): void {
    const chars = attachments.reduce((sum, file) => sum + (file.mimeType.startsWith('image/') ? 1500 : Math.round(file.sizeBytes / 2)), 0)
    if (chars > 0) this.handlers.onContextTraffic?.(chars)
  }

  /**
   * Tell the page to treat everything currently rendered — and whatever renders
   * next — as pre-existing.
   *
   * Called whenever the app moves to another conversation while auto mode is on,
   * and when auto mode is switched on. Without it, opening an old conversation
   * whose last reply contains a command would execute that command immediately.
   */
  async armCommandBaseline(): Promise<boolean> {
    const contents = this.liveContents()
    if (!contents) return false

    try {
      await contents.executeJavaScript(
        `window.__cmdTerminalInterceptor
           ? window.__cmdTerminalInterceptor.armBaseline()
           : false`
      )
      return true
    } catch {
      return false
    }
  }

  /** Re-scan the last reply immediately, bypassing the settle delay. */
  async checkForCommandNow(): Promise<boolean> {
    const contents = this.liveContents()
    if (!contents) return false

    const previousStartedAt = this.interceptor.taskStartedAt
    const previousFinishedAt = this.interceptor.taskFinishedAt
    this.interceptor.taskStartedAt = Date.now()
    this.interceptor.taskFinishedAt = null
    this.handlers.onInterceptor(this.getInterceptorStatus())

    try {
      await contents.executeJavaScript(
        `window.__cmdTerminalInterceptor && window.__cmdTerminalInterceptor.checkNow(); true`
      )
      return true
    } catch {
      this.interceptor.taskStartedAt = previousStartedAt
      this.interceptor.taskFinishedAt = previousFinishedAt
      this.handlers.onInterceptor(this.getInterceptorStatus())
      return false
    }
  }

  /**
   * Read the page's own sidebar markup and return every conversation it lists.
   *
   * `executeJavaScript` resolves in the page's main world. It is awaited — and
   * its result validated — because the page can navigate away mid-call, in which
   * case the promise resolves against a destroyed context.
   */
  async scrapeConversations(): Promise<ScrapedConversation[]> {
    const contents = this.liveContents()
    if (!contents) return []
    // A platform without a sidebar scraper simply has no "sync" feature.
    if (this.platform.sidebarScript === '') return []

    try {
      const raw = (await contents.executeJavaScript(this.platform.sidebarScript)) as unknown
      if (!Array.isArray(raw)) return []

      return (raw as ScrapeResult[])
        .filter((item) => item && typeof item.id === 'string' && typeof item.title === 'string')
        // Placeholder routes (ChatGPT's /c/WEB, for instance) are linked in the UI but
        // are not conversations, so they must never reach the database.
        .filter((item) => isConversationId(item.id))
        .map((item) => ({
          id: item.id,
          title: item.title.trim(),
          url: this.platform.conversationUrl(item.id)
        }))
        .filter((item) => item.title !== '')
    } catch (error) {
      // A navigation during the call is normal, not worth crashing over.
      console.warn('[embed] sidebar scrape failed:', (error as Error).message)
      return []
    }
  }

  /**
   * Current snapshot of the embedded view.
   *
   * The renderer pulls this once on mount: the first batch of embed events
   * (did-start-loading / did-navigate) fires while the window is still being
   * created, i.e. before React has subscribed, so push-only updates would leave
   * the UI stuck on its initial "loading" state.
   */
  getState(): EmbedState {
    const contents = this.liveContents()
    if (!contents) {
      return {
        url: '',
        title: '',
        isLoading: false,
        canGoBack: false,
        canGoForward: false,
        conversationId: null,
        botCheckSince: null
      }
    }

    const url = contents.getURL()
    return {
      url,
      title: contents.getTitle(),
      isLoading: contents.isLoading(),
      canGoBack: contents.navigationHistory.canGoBack(),
      canGoForward: contents.navigationHistory.canGoForward(),
      conversationId: conversationIdOf(this.platform, url),
      botCheckSince: this.botCheckSince
    }
  }

  /** Remove the view from the window and release its web contents. */
  destroy(parent: BrowserWindow): void {
    // Stop watching for a bot check before the page goes away: the timer holds the contents, and
    // a tick after teardown would read a destroyed webContents.
    this.endBotCheckWait()
    this.hiddenViewProbe?.stop()
    this.hiddenViewProbe = null
    this.selectionQuestion?.destroy()
    this.selectionQuestion = null

    const view = this.view
    if (!view) return

    this.view = null
    if (!parent.isDestroyed()) parent.contentView.removeChildView(view)
    if (!view.webContents.isDestroyed()) view.webContents.close()
  }

  /**
   * Parse a console line emitted by the injected script.
   *
   * The count is accumulated HERE rather than taken from the page, because the
   * page's own counter resets on every full reload.
   */
  private async deliverUserMessage(text: string, attachmentToken: string | null, focusTurnId?: string): Promise<void> {
    let attachments: ConversationImageAttachmentInput[] = []
    if (attachmentToken) {
      const contents = this.liveContents()
      if (contents && !contents.isDestroyed()) {
        try {
          const raw = (await contents.executeJavaScript(
            `window.__cmdTerminalInterceptor?.takeUserImageAttachments
              ? window.__cmdTerminalInterceptor.takeUserImageAttachments(${JSON.stringify(attachmentToken)})
              : []`
          )) as unknown
          if (Array.isArray(raw)) {
            attachments = raw
              .filter((value): value is Record<string, unknown> => value !== null && typeof value === 'object')
              .map((value) => ({
                fileName: typeof value.fileName === 'string' ? value.fileName : '',
                mimeType: typeof value.mimeType === 'string' ? value.mimeType : '',
                dataBase64: typeof value.dataBase64 === 'string' ? value.dataBase64 : '',
                width: typeof value.width === 'number' && Number.isFinite(value.width) ? value.width : null,
                height: typeof value.height === 'number' && Number.isFinite(value.height) ? value.height : null,
                sizeBytes:
                  typeof value.sizeBytes === 'number' && Number.isFinite(value.sizeBytes)
                    ? value.sizeBytes
                    : 0
              }))
              .filter((value) => value.mimeType.startsWith('image/') && value.dataBase64 !== '')
          }
        } catch (error) {
          console.warn(`[embed:${this.platform.id}] user attachment capture failed:`, (error as Error).message)
        }
      }
    }
    if (text.trim() !== '' || attachments.length > 0) this.handlers.onUserMessage(text, attachments, focusTurnId, 'page')
  }
  private taskActionSource(payload: InterceptorPageEvent): import('../shared/types').TaskActionSource | undefined {
    if (this.platform.page.computerUseRequests !== true || !this.computerUseRecognitionEnabled || payload.live !== true ||
      payload.taskPromptGeneration !== this.taskPromptGeneration || typeof payload.sourceSubmissionId !== 'string' ||
      !/^user:[a-zA-Z0-9:-]{1,150}$/.test(payload.sourceSubmissionId)) return undefined
    try {
      const url = new URL(this.liveContents()!.getURL())
      if (this.platform.allowedOriginPattern.test(url.href) && payload.pagePath === url.pathname && this.platform.conversationIdFromPath(url.pathname))
        return { sourceSubmissionId: payload.sourceSubmissionId, taskPromptGeneration: payload.taskPromptGeneration, pagePath: url.pathname }
    } catch { /* Navigation or unavailable page cannot supply task provenance. */ }
    return undefined
  }

  private handlePageReport(message: string): void {
    if (typeof message !== 'string' || !message.startsWith(INTERCEPTOR_LOG_TAG)) return

    let payload: InterceptorPageEvent
    try {
      payload = JSON.parse(message.slice(INTERCEPTOR_LOG_TAG.length)) as InterceptorPageEvent
    } catch {
      return
    }

    let questionAccepted: boolean | undefined
    let computerAccepted: boolean | undefined
    // A confirmed send replans at once; the log line describes the plan the send carried.
    const injectionMode = this.injectionPlan?.mode ?? null
    switch (payload.event) {
      case 'installed':
        this.interceptor.installed = true
        break
      case 'continue-generation':
        // The page measured the button; only a trusted input event actually presses it.
        if (payload.reason === 'continue-clicked') this.clickAt(payload.x, payload.y)
        console.info(`[embed:${this.platform.id}] interceptor ${JSON.stringify(payload)}`)
        break
      case 'native-edit':
        // Same rule as 继续生成: the page measured the control; only a trusted input event presses it.
        this.clickNativeEdit(payload)
        console.info(`[embed:${this.platform.id}] interceptor ${JSON.stringify(payload)}`)
        break
      case 'focus-ui-click':
        if (payload.focusEditToken && this.focusUiNativeClick?.token === payload.focusEditToken) this.focusUiNativeClick.dispatch()
        break
      case 'focus-model-click':
        if (payload.focusModelToken && payload.focusModelToken === this.focusModelNativeClick?.token && typeof payload.count === 'number') this.focusModelNativeClick.dispatch(payload.count)
        break
      case 'configured':
        this.interceptor.installed = true
        /*
         * The page reports the prompt it was just given, every time it is configured. Logged for
         * the same reason as `injected` below: the prompt lives per view, so "the page holds an
         * older or generic prompt" is a silent failure otherwise.
         */
        console.info(
          `[embed:${this.platform.id}] configured enabled=${payload.enabled} ` +
            `page-prompt=${payload.prefixLength ?? '?'} main-prompt=${this.pushedPrefix?.length ?? this.interceptor.prefix.length} ` +
            `${payload.prefixLength === (this.pushedPrefix?.length ?? this.interceptor.prefix.length) ? 'MATCH' : 'MISMATCH'}`
        )
        break
      case 'injected':
        if (payload.taskPromptGeneration !== undefined && payload.taskPromptGeneration !== this.taskPromptGeneration) break
        this.interceptor.injectedCount += 1
        if (payload.promptInjected !== false) this.injectedPrefixLength = Number.isSafeInteger(payload.prefixLength) ? payload.prefixLength! : null
        /*
         * Log which prompt the PAGE actually holds, and compare it with what main thinks it
         * pushed. The two can diverge because the prefix lives per view: a view created before
         * the environment probe, or reconfigured while it had no live contents, keeps the
         * generic fallback — and the only visible symptom is messages going out un-prefixed.
         */
        if (payload.promptInjected === false) {
          console.info(`[embed:${this.platform.id}] reply contract injected chars=${payload.prefixLength ?? '?'}`)
          break
        }
        console.info(
          `[embed:${this.platform.id}] injected #${this.interceptor.injectedCount} ` +
            `page-prompt=${payload.prefixLength ?? '?'} main-prompt=${this.pushedPrefix?.length ?? this.interceptor.prefix.length} ` +
            `page-head=${JSON.stringify(payload.prefixHead ?? '')} ` +
            `${payload.prefixLength === (this.pushedPrefix?.length ?? this.interceptor.prefix.length) ? 'MATCH' : 'MISMATCH'}`
        )
        break
      case 'send-observed':
        console.info(`[embed:${this.platform.id}] user send ${payload.trigger ?? '?'} ${payload.reason ?? 'unknown'}`)
        break
      case 'user-message': {
        if (payload.taskPromptGeneration !== undefined && payload.taskPromptGeneration !== this.taskPromptGeneration) break
        const submission: TaskSubmission | undefined = typeof payload.submissionId === 'string' && /^[\w:-]{1,160}$/.test(payload.submissionId) &&
          (payload.submissionKind === 'goal' || payload.submissionKind === 'clarification')
          ? { id: payload.submissionId, kind: payload.submissionKind } : undefined
        const answerBinding = payload.answeredQuestionId ? this.taskQuestionBindings?.get(payload.answeredQuestionId) ??
          (this.taskQuestion?.messageId === payload.answeredQuestionId ? this.taskQuestion.source : null) : null
        if (submission?.kind === 'clarification' && payload.questionSource && answerBinding && validTaskQuestionSource(payload.questionSource) &&
          payload.questionSource.pageEpoch === this.computerPageEpoch && payload.questionSource.taskPromptGeneration === this.taskPromptGeneration &&
          sameQuestionSource(payload.questionSource, answerBinding))
          submission.answerTo = { ...payload.questionSource, messageId: payload.answeredQuestionId! }
        if (submission && this.userSubmissions.has(submission.id)) break
        const text = typeof payload.text === 'string' ? payload.text : ''
        const editToken = typeof payload.focusEditToken === 'string' ? payload.focusEditToken : undefined
        if (editToken && editToken !== this.focusEditToken) break
        const focusSendToken = typeof payload.focusSendToken === 'string' ? payload.focusSendToken : null
        const providedImages = focusSendToken ? this.focusSendImages.get(focusSendToken) : undefined
        // A focus upload acknowledgement must belong to this exact outstanding send.
        // Consume it once; duplicate or late acknowledgements cannot create another human turn.
        if (focusSendToken && !providedImages) break
        const attachmentToken =
          typeof payload.attachmentToken === 'string' && payload.attachmentToken !== ''
            ? payload.attachmentToken
            : null
        console.info(
          `[embed:${this.platform.id}] user-message textLength=${text.length} ` +
            `attachmentToken=${attachmentToken ? 'yes' : 'no'}`
        )
        if (text.trim() !== '' || attachmentToken || providedImages) {
          if (submission?.kind === 'goal') { this.taskQuestion = null; this.taskQuestionBindings?.clear(); this.taskQuestionContext = null }
          const files = Array.isArray(payload.focusFiles) ? payload.focusFiles.slice(0, 3).filter(file =>
            file && typeof file.fileName === 'string' && file.fileName.length <= 240 &&
            typeof file.mimeType === 'string' && file.mimeType.length <= 160 && Number.isSafeInteger(file.sizeBytes) && file.sizeBytes > 0) : []
          const scheduledRunId = typeof payload.scheduledRunId === 'string' && payload.scheduledRunId.length <= 128 ? payload.scheduledRunId : undefined
          const turnId = this.handlers.onUserStarted?.(text, files, editToken, submission, scheduledRunId)
          if (editToken && !turnId) break
          if (payload.contextUsage) this.contextUsage?.confirmedUsage(payload.contextUsage, 'injection', 'prefix:' + payload.contextUsage.id)
          if (submission) {
            this.userSubmissions.add(submission.id)
            if (this.userSubmissions.size > 1000) this.userSubmissions.delete(this.userSubmissions.values().next().value!)
          }
          if (providedImages) {
            this.focusSendImages.delete(focusSendToken!)
            this.handlers.onUserMessage(text, providedImages, turnId, 'provided')
          } else void this.deliverUserMessage(text, attachmentToken, turnId)
        }
        break
      }
      case 'user-image-capture':
        console.info(
          `[embed:${this.platform.id}] user-image-capture ` +
            `phase=${payload.phase ?? '?'} count=${payload.count ?? 0}`
        )
        break
      case 'assistant-message':
        if (payload.messageId && typeof payload.text === 'string' && payload.text.trim() !== '') {
          this.handlers.onAssistantMessage(payload.messageId, payload.text)
        }
        break
      case 'assistant-history-markdown':
        if (payload.messageId && typeof payload.text === 'string' && payload.text.trim() !== '') {
          this.handlers.onAssistantHistoryMarkdown(payload.messageId, payload.text)
        }
        break
      case 'sent-raw':
        // A computer observation's screenshot counts as a fixed amount of context, like noteAttachmentTraffic's images.
        this.handlers.onRawSent?.((Number.isSafeInteger(payload.textLength) ? payload.textLength! : 0) + (payload.attachmentKind === 'computer' ? 1500 : 0))
        break
      case 'sent':
        if (payload.taskPromptGeneration !== this.taskPromptGeneration) break
        if (payload.contextUsage) this.contextUsage?.confirmedUsage(payload.contextUsage, 'injection', 'prefix:' + payload.contextUsage.id)
        if (payload.promptInjected === false && payload.replyProtocolKind === 'short' &&
          payload.replyProtocolVersion === REPLY_PROTOCOL_VERSION && payload.replyProtocolLength === REPLY_PROTOCOL_REMINDER.length) {
          this.handlers.onContextTraffic?.(REPLY_PROTOCOL_REMINDER.length)
        }
        if (payload.promptInjected === true) this.taskPromptInjected = true
        if (payload.promptInjected === true || payload.conversationPromptInjected === true) {
          const contents = this.liveContents()
          if (contents) this.handlers.onPromptInjected?.(conversationIdOf(this.platform, contents.getURL()))
          if (contents && payload.promptInjected === true) {
            const plan = this.injectionPlan && this.injectionPlan.prefix.length === this.injectedPrefixLength ? this.injectionPlan : null
            this.injectedPrefixLength = null
            this.handlers.onInjectionSent?.(conversationIdOf(this.platform, contents.getURL()), plan)
          }
        }
        console.info(
          `[embed:${this.platform.id}] sent promptInjected=${payload.promptInjected === true} ` +
            `taskPromptInjected=${this.taskPromptInjected}`
        )
        this.interceptor.pendingQuestion = null
        this.interceptor.lastSentText = payload.text ?? null
        if (this.interceptor.taskStartedAt === null || this.interceptor.taskFinishedAt !== null) {
          this.interceptor.taskStartedAt = Date.now()
        }
        this.interceptor.taskFinishedAt = null
        this.interceptor.commandRecovery = null
        break
      case 'question':
        {
          const candidates: unknown[] = Array.isArray(payload.questions)
            ? payload.questions
            : typeof payload.question === 'string'
              ? [{ question: payload.question, placeholder: payload.placeholder, options: payload.options }]
              : []
          const questions: PendingQuestionItem[] = candidates.map((item) => {
            if (!item || typeof item !== 'object') return null
            const value = item as { question?: unknown; placeholder?: unknown; options?: unknown }
            if (
              typeof value.question !== 'string' || value.question.trim() === '' || value.question.length > 16000 ||
              (value.placeholder !== undefined && (typeof value.placeholder !== 'string' || value.placeholder.length > 1000))
            ) return null
            if (
              value.options !== undefined &&
              (!Array.isArray(value.options) || value.options.length > 8 ||
                value.options.some((option) => typeof option !== 'string' || option.trim() === '' || option.length > 300))
            ) return null
            return {
              question: value.question.trim(),
              placeholder: typeof value.placeholder === 'string' ? value.placeholder.trim() : '',
              options: ((value.options ?? []) as string[]).map((option) => option.trim())
            }
          }).filter((item): item is PendingQuestionItem => item !== null)
          const messageId = payload.messageId
          const validQuestion = (
            payload.live === true &&
            typeof messageId === 'string' && messageId !== '' &&
            questions.length === candidates.length && questions.length >= 1 && questions.length <= 20
          )
          questionAccepted = validQuestion
          if (validQuestion) {
            if (typeof payload.rawJson === 'string' && payload.rawJson.length <= 1_000_000)
              this.contextUsage?.confirmed(payload.rawJson, 'tool-request', messageId!, messageId!)
            const isNewQuestion = this.interceptor.pendingQuestion?.messageId !== messageId
            this.interceptor.pendingQuestion = {
              messageId,
              questions,
              ...(this.taskQuestionContext?.messageId === messageId ? { taskContext: structuredClone(this.taskQuestionContext.owner) } : {})
            }
            if (isNewQuestion && payload.questionReplay !== true && payload.questionSource && validTaskQuestionSource(payload.questionSource) &&
              payload.questionSource.pageEpoch === this.computerPageEpoch && this.taskActionSource({ ...payload, ...payload.questionSource })) {
              this.taskQuestion = { messageId, source: structuredClone(payload.questionSource) }
              this.taskQuestionBindings ??= new Map()
              this.taskQuestionBindings.set(messageId, structuredClone(payload.questionSource))
              if (this.taskQuestionBindings.size > 32) this.taskQuestionBindings.delete(this.taskQuestionBindings.keys().next().value!)
              this.handlers.onTaskQuestion?.(this.interceptor.pendingQuestion, payload.questionSource)
            }
            console.info(`[embed:${this.platform.id}] question waiting messageId=${payload.messageId}`)
            // Capture the clarification immediately so the alternate conversation view
            // shows the model's questions alongside the later user answers. The injected
            // page script also reports assistant-message for this turn; the database's
            // source-message uniqueness makes that duplicate harmless.
            if (isNewQuestion) this.handlers.onQuestion(questions[0].question, questions.length)
            if (typeof payload.rawJson === 'string') this.handlers.onQuestionRecorded(messageId, payload.rawJson)
            this.handlers.onAssistantMessage(
              messageId,
              questions.map((item, index) => `${index + 1}. ${item.question}`).join('\n')
            )
          }
        }
        break
      case 'question-cleared':
        if (this.interceptor.pendingQuestion?.messageId === payload.messageId) this.interceptor.pendingQuestion = null
        break
      case 'question-history':
        if (typeof payload.messageId === 'string' && payload.messageId !== '' && typeof payload.rawJson === 'string') {
          this.handlers.onQuestionRecorded(payload.messageId, payload.rawJson)
        }
        break
      case 'task-finished': {
        /*
         * Logged, because this is a STATE TRANSITION with teeth: it is what clears
         * `awaitingReplySince` on the page and what decides whether the task is over. A reply
         * judged final too early is the difference between the loop continuing and the loop
         * stopping, and it used to leave no trace at all.
         */
        console.info(
          `[embed:${this.platform.id}] task-finished completed=${payload.completed === true} ` +
            `messageId=${payload.messageId ?? '?'}`
        )
        if (payload.completed === true && this.interceptor.taskFinishedAt === null) {
          const source = this.taskActionSource(payload)
          if (this.computerUseRecognitionEnabled && this.platform.page.computerUseRequests === true &&
            (!source || payload.computerPageEpoch !== this.computerPageEpoch ||
              typeof payload.messageId !== 'string' || !payload.messageId.trim() || payload.messageId.length > 512)) break
          const generation = this.taskPromptGeneration
          if (this.handlers.onTaskCompleted(payload.messageId, source) === false) break
          // The coordinator's completion callback may already have ended this embed.
          if (this.taskPromptGeneration === generation) this.completeTask()
        }
        break
      }
      case 'computer-request': {
        computerAccepted = false
        // This is an untrusted recognition event, never an executable command or a Shell fallback.
        const contents = this.liveContents()
        if (this.platform.page.computerUseRequests !== true || !this.computerUseRecognitionEnabled || !contents || payload.live !== true ||
          typeof payload.computerPageEpoch !== 'string' || payload.computerPageEpoch !== this.computerPageEpoch ||
          payload.taskPromptGeneration !== this.taskPromptGeneration ||
          typeof payload.messageId !== 'string' || !/^computer:[a-zA-Z0-9:-]{1,150}$/.test(payload.messageId) ||
          typeof payload.sourceSubmissionId !== 'string' || !/^user:[a-zA-Z0-9:-]{1,150}$/.test(payload.sourceSubmissionId) ||
          typeof payload.rawJson !== 'string' || !payload.rawJson.trim() || payload.rawJson.length > 64_000 ||
          !['candidate', 'invalid'].includes(payload.computerOutcome ?? '') ||
          ![null, 'invalid-json', 'ambiguous-request', 'oversized-request'].includes(payload.computerIssue ?? null) ||
          (payload.computerOutcome === 'candidate' ? payload.computerIssue !== null : !payload.computerIssue)) break
        try {
          const url = new URL(contents.getURL())
          if (!this.platform.allowedOriginPattern.test(url.href) || payload.pagePath !== url.pathname ||
            !this.platform.conversationIdFromPath(url.pathname)) break
        } catch { break }
        this.contextUsage?.confirmed(payload.rawJson, 'tool-request', payload.messageId, payload.messageId)
        computerAccepted = this.handlers.onComputerRequest?.({ messageId: payload.messageId, sourceSubmissionId: payload.sourceSubmissionId,
          taskPromptGeneration: payload.taskPromptGeneration, pagePath: payload.pagePath!, rawJson: payload.rawJson,
          pageEpoch: payload.computerPageEpoch,
          outcome: payload.computerOutcome!, issue: payload.computerIssue ?? null }) === true
        break
      }
      case 'command': {
        const taskSource = this.taskActionSource(payload)
        if (payload.sourceSubmissionId !== undefined && !taskSource) break
        if (payload.live === true) this.interceptor.commandRecovery = null
        console.info(
          `[embed:${this.platform.id}] command detected live=${payload.live === true} ` +
            JSON.stringify({
              messageId: payload.messageId,
              command: payload.command,
              description: payload.description,
              timeoutSeconds: payload.timeoutSeconds
            })
        )
        if (payload.messageId && typeof payload.command === 'string') {
          if (payload.live === true) this.contextUsage?.confirmed(typeof payload.rawJson === 'string' ? payload.rawJson
            : JSON.stringify({ command: payload.command, description: payload.description, timeoutSeconds: payload.timeoutSeconds }),
          'tool-request', payload.messageId, payload.messageId)
          this.handlers.onCommand({
            messageId: payload.messageId,
            command: payload.command,
            background: payload.background === true,
            backgroundOptions: payload.backgroundOptions,
            description: payload.description ?? '',
            timeoutSeconds: Number(payload.timeoutSeconds ?? 120),
            rawJson: typeof payload.rawJson === 'string' ? payload.rawJson : undefined,
            live: payload.live === true,
            ...(taskSource ? { taskSource } : {})
          })
        }
        break
      }
      case 'read-files': {
        const taskSource = this.taskActionSource(payload)
        if (payload.sourceSubmissionId !== undefined && !taskSource) break
        const request = parseReadFilesRequest({ type: 'read_files', files: payload.files, description: payload.description })
        if (fileReadingPlatform(this.platform.id) && request && typeof payload.messageId === 'string' && payload.messageId) {
          if (payload.live === true) this.interceptor.commandRecovery = null
          if (payload.live === true) this.contextUsage?.confirmed(typeof payload.rawJson === 'string' ? payload.rawJson : JSON.stringify(request),
            'tool-request', payload.messageId, payload.messageId)
          this.handlers.onCommand({ ...request, messageId: payload.messageId, live: payload.live === true, ...(taskSource ? { taskSource } : {}) })
        }
        break
      }
      case 'mail-notification': {
        if (payload.live !== true || payload.taskPromptGeneration !== this.taskPromptGeneration ||
          typeof payload.sourceSubmissionId !== 'string' || !this.userSubmissions.has(payload.sourceSubmissionId) ||
          typeof payload.messageId !== 'string' || !payload.messageId || payload.messageId.length > 512 ||
          typeof payload.rawJson !== 'string' || payload.rawJson.length > 125_000 || payload.computerPageEpoch !== this.computerPageEpoch) break
        const contents = this.liveContents()
        if (!contents) break
        const url = new URL(contents.getURL())
        const conversationId = this.platform.conversationIdFromPath(url.pathname)
        if (url.origin !== new URL(this.platform.homeUrl).origin || !conversationId || payload.pagePath !== url.pathname) break
        this.contextUsage?.confirmed(payload.rawJson, 'tool-request', payload.messageId, payload.messageId)
        this.handlers.onMailNotification?.({ messageId: payload.messageId, rawJson: payload.rawJson, conversationId,
          pageEpoch: this.computerPageEpoch, sourceSubmissionId: payload.sourceSubmissionId })
        break
      }
      case 'tool-prompt-read': {
        if (payload.live !== true || payload.taskPromptGeneration !== this.taskPromptGeneration ||
          typeof payload.sourceSubmissionId !== 'string' || !this.userSubmissions.has(payload.sourceSubmissionId) ||
          typeof payload.messageId !== 'string' || !payload.messageId || payload.messageId.length > 512 ||
          typeof payload.rawJson !== 'string' || payload.rawJson.length > 4000 || payload.computerPageEpoch !== this.computerPageEpoch) break
        const contents = this.liveContents()
        if (!contents) break
        const url = new URL(contents.getURL())
        const conversationId = this.platform.conversationIdFromPath(url.pathname)
        if (url.origin !== new URL(this.platform.homeUrl).origin || !conversationId || payload.pagePath !== url.pathname) break
        this.contextUsage?.confirmed(payload.rawJson, 'tool-request', payload.messageId, payload.messageId)
        this.handlers.onToolPromptRead?.({ messageId: payload.messageId, rawJson: payload.rawJson, conversationId,
          pageEpoch: this.computerPageEpoch, sourceSubmissionId: payload.sourceSubmissionId })
        break
      }
      case 'scheduled-task': {
        if (payload.live !== true || typeof payload.messageId !== 'string' || !payload.messageId || payload.messageId.length > 512 ||
          typeof payload.rawJson !== 'string' || payload.rawJson.length > 25_000 || payload.computerPageEpoch !== this.computerPageEpoch) break
        const contents = this.liveContents()
        if (!contents) break
        const url = new URL(contents.getURL())
        const conversationId = this.platform.conversationIdFromPath(url.pathname)
        if (url.origin !== new URL(this.platform.homeUrl).origin || !conversationId || payload.pagePath !== url.pathname) break
        this.contextUsage?.confirmed(payload.rawJson, 'tool-request', payload.messageId, payload.messageId)
        this.handlers.onScheduledTask?.({ messageId: payload.messageId, rawJson: payload.rawJson, conversationId,
          pageEpoch: this.computerPageEpoch, sourceSubmissionId: typeof payload.sourceSubmissionId === 'string' ? payload.sourceSubmissionId : undefined })
        break
      }
      case 'parse-failed':
        if (payload.live === true && payload.taskPromptGeneration !== this.taskPromptGeneration) break
        console.warn(`[embed:${this.platform.id}] parse-failed ${JSON.stringify(payload)}`)
        if (payload.live === true && payload.messageId && Number.isSafeInteger(payload.parseFailureToken) &&
          payload.taskPromptGeneration === this.taskPromptGeneration) {
          this.setCommandRecovery({ messageId: payload.messageId, token: payload.parseFailureToken!,
            generation: payload.taskPromptGeneration!, status: payload.recoveryStatus === 'failed' ? 'failed' : 'pending' })
        }
        this.handlers.onParseFailed(payload)
        break
      case 'command-recovery': {
        const current = this.interceptor.commandRecovery
        if (current && current.token === payload.parseFailureToken && current.generation === payload.taskPromptGeneration &&
          current.messageId === payload.messageId && ['pending', 'sent', 'blocked', 'failed', 'uncertain'].includes(payload.recoveryStatus ?? '')) {
          this.setCommandRecovery({ ...current, status: payload.recoveryStatus! })
        }
        break
      }
      case 'raw-busy': {
        const logPath = writeRawSendDiagnostic(this.platform.id, payload)
        console.warn(`[embed:${this.platform.id}] raw send blocked; log: ${logPath ?? 'unavailable'}`)
        break
      }
      /*
        * The scan notes: one line per changed snapshot saying why a settled reply produced no
       * command. Without them, "the model answered with JSON and nothing happened" is
       * undiagnosable — every path leading there returns silently.
       */
      case 'scan':
        console.info(`[embed:${this.platform.id}] scan ${JSON.stringify(payload)}`)
        break
      /*
       * The theme report — the only evidence this app will ever have that the page is painted
       * the way the app asked for.
       *
       * Nothing else here reads a colour or a class, so a page that ignored the theme and a
       * page that followed it are indistinguishable everywhere else: same URL, same title,
       * same everything. It is logged in full (the hooks that were tried, what each measured,
       * and the site's own theme-shaped storage keys) because a wrong verdict here is
       * otherwise unfalsifiable.
       *
       * Level follows meaning: `none` and `contested` are the two states where the page is
       * NOT following the app and something has to change, so they are warnings. The rest —
       * including `unknown`, which is a page that has not finished painting yet and is
       * retried on a timer — are information.
       */
      case 'theme':
        if (payload.applied === 'none' || payload.applied === 'contested' || payload.applied === 'error') {
          console.warn(`[embed:${this.platform.id}] theme ${JSON.stringify(payload)}`)
        } else {
          console.info(`[embed:${this.platform.id}] theme ${JSON.stringify(payload)}`)
        }
        break
      case 'send-failed':
      case 'send-recovery':
      case 'end-task':
      case 'inject-failed':
        /*
         * The DETAIL is the point, not the event name.
         *
         * This used to print one word — `interceptor reported send-failed` — while the page
         * held everything needed to explain it: whether a send button existed at all, whether
         * it was disabled, what was left in the composer, and what the composer's toolbar
         * actually contained. "The result is written into the box and never sent" is not
         * diagnosable from the word alone. The whole payload goes out now, and `DSH_APP_LOG=1`
         * mirrors it into `<userData>/logs/`.
         *
         * `end-task` rides along for the same reason: whether ç»“æŸä»»åŠ¡ can stop the model turns
         * entirely on `stopButtonSelectors`, and this is the only place that ever sees them at
         * the one moment they exist.
         */
        console.warn(`[embed:${this.platform.id}] interceptor ${JSON.stringify(payload)}`)
        break
      default:
        break
    }

    const contents = this.liveContents()
    const replyLogPath = writeReplyDiagnostic(this.platform.id, payload, {
      viewId: contents?.id ?? null,
      conversationId: contents ? conversationIdOf(this.platform, contents.getURL()) : null,
      mainPendingQuestion: this.interceptor.pendingQuestion !== null,
      mainTaskPromptGeneration: this.taskPromptGeneration,
      computerAccepted,
      questionAccepted
    })
    if (replyLogPath && replyLogPath !== this.replyDiagnosticLogPath) {
      this.replyDiagnosticLogPath = replyLogPath
      console.info(`[embed:${this.platform.id}] reply diagnostics log: ${replyLogPath}`)
    }
    // A refused live desktop request is never answered; end the page's wait for it so a resume or a
    // human send is not refused as "awaiting reply" forever.
    if (payload.event === 'computer-request' && computerAccepted === false && payload.live === true &&
      typeof payload.messageId === 'string' && /^computer:[a-zA-Z0-9:-]{1,150}$/.test(payload.messageId)) {
      const contents = this.liveContents()
      if (contents) void contents.executeJavaScript(`window.__cmdTerminalInterceptor?.releaseRejectedComputer(${JSON.stringify(payload.messageId)})`).catch(() => {})
    }
    writePromptDiagnostic(this.platform.id, payload, {
      taskPromptInjected: this.taskPromptInjected,
      taskPromptGeneration: this.taskPromptGeneration,
      injectionMode,
      taskActive: this.interceptor.enabled && this.interceptor.promptInjectionEnabled &&
        this.interceptor.taskStartedAt !== null && this.interceptor.taskFinishedAt === null,
      currentPage: payload.computerPageEpoch === this.computerPageEpoch
    })
    this.handlers.onInterceptor(this.getInterceptorStatus())
  }

  /** Only the live DeepSeek task may request the measured edit/send controls. */
  private clickNativeEdit(payload: InterceptorPageEvent): void {
    const analysis = payload.reason === 'analysis-leak-edit-click' || payload.reason === 'analysis-leak-send-click'
    const stopped = payload.reason === 'stopped-retry-edit-click' || payload.reason === 'stopped-retry-send-click'
    const safety = payload.reason === 'safety-leak-edit-click' || payload.reason === 'safety-leak-send-click'
    if ((!analysis && !safety && !stopped) || this.platform.id !== 'deepseek' || !this.platform.page.nativeEdit ||
      (stopped && !this.platform.page.nativeEdit.retryStoppedByEditing) ||
      !this.interceptor.enabled || this.interceptor.taskFinishedAt !== null ||
      payload.taskPromptGeneration !== this.taskPromptGeneration || payload.taskActive !== true ||
      payload.awaitingReply !== true || this.interceptor.pendingQuestion ||
      (safety && !this.computerUseRecognitionEnabled)) return
    const contents = this.liveContents()
    if (!contents) return
    try {
      const url = new URL(contents.getURL())
      if (!this.platform.allowedOriginPattern.test(url.href) || payload.pagePath !== url.pathname) return
    } catch { return }
    this.clickAt(payload.x, payload.y)
  }

  /** A real left click at a viewport CSS-pixel point; input events are in DIPs, hence the zoom. */
  private clickAt(x: unknown, y: unknown): void {
    const contents = this.liveContents()
    if (!contents || typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) return
    const zoom = contents.getZoomFactor()
    const point = { x: Math.round(x * zoom), y: Math.round(y * zoom) }
    contents.sendInputEvent({ type: 'mouseMove', ...point })
    contents.sendInputEvent({ type: 'mouseDown', ...point, button: 'left', clickCount: 1 })
    contents.sendInputEvent({ type: 'mouseUp', ...point, button: 'left', clickCount: 1 })
  }

  private liveContents(): Electron.WebContents | null {
    const view = this.view
    if (!view || view.webContents.isDestroyed()) return null
    return view.webContents
  }

  /**
   * Persist the conversation currently on screen, if the URL is one.
   * Deduped so the many navigation/title events do not cause repeated writes.
   */
  private captureCurrentConversation(): void {
    const contents = this.liveContents()
    if (!contents) return

    const url = contents.getURL()
    const id = conversationIdOf(this.platform, url)
    if (!id) return

    /*
     * Every one of these sites uses its own product name as the generic document title
     * ("ChatGPT", "DeepSeek") — that is the shell, not a conversation name. Storing the
     * product name as the conversation's title would then outrank the real one from the
     * sidebar scrape, because a non-empty title is never overwritten.
     */
    const rawTitle = contents.getTitle()
    const label = this.platform.label
    const title =
      rawTitle === label || rawTitle.startsWith(`${label}:`) || rawTitle.startsWith(`${label} -`)
        ? ''
        : rawTitle

    const key = `${id}\u0000${title}`
    if (key === this.lastCaptured) return
    this.lastCaptured = key

    this.handlers.onConversation({ id, url: this.platform.conversationUrl(id), title })
  }

  /**
   * Best-effort refresh of the stored list from the sidebar, so the panel fills
   * itself without the user pressing anything. Throttled: did-stop-loading can
   * fire repeatedly during ChatGPT's client-side routing.
   */
  private autoSync(): void {
    const now = Date.now()
    if (now - this.lastSyncAt < 15000) return
    this.lastSyncAt = now

    void this.scrapeConversations().then((conversations) => {
      if (conversations.length > 0) this.handlers.onSynced(conversations)
    })
  }

  /**
   * Keep a natively hidden page rendering and reporting visible to its own site.
   *
   * The 2026-10-30 user probe on Electron 44.4.3 measured a real viewport and advancing
   * animation frames, but document.visibilityState remained hidden until the first native
   * show. Repeating setBackgroundThrottling(false) did not change it. Painting alone is
   * insufficient for a site that defers work while its document is hidden.
   *
   * Electron 44.5.0+ re-applies renderer visibility in SetSchedulerThrottling (#54311,
   * backport #54341), in addition to the hidden-but-painting widget repair (#52844).
   * Keep that runtime floor in package.json/lock; reapply after document loads, navigation
   * and native hiding. No native show, focus, page visibility override or repeated send.
   */
  private keepRenderingWhileHidden(): void {
    const contents = this.liveContents()
    if (!contents) return
    try { contents.setBackgroundThrottling(false) } catch { /* a closing page needs nothing */ }
  }

  private applyBounds(): void {
    const view = this.view
    if (!view || view.webContents.isDestroyed()) return

    const { x, y, width, height } = this.bounds
    // A zero-sized or hidden slot must not keep a native rectangle on screen.
    if (width < 1 || height < 1) {
      view.setVisible(false)
      this.keepRenderingWhileHidden()
      this.hiddenViewProbe?.note('zero-slot')
      return
    }

    view.setBounds({
      x: Math.round(x),
      y: Math.round(y),
      width: Math.round(width),
      height: Math.round(height)
    })
    // A hidden chat still needs a real viewport for its composer and virtual list.
    view.setVisible(this.visible)
    // Native hiding/relayout can happen after dom-ready and navigation hooks.
    // Reassert hidden-but-painting AFTER hiding, with the real viewport already applied.
    if (!this.visible) this.keepRenderingWhileHidden()
    this.hiddenViewProbe?.note(this.visible ? 'shown' : 'hidden')
  }

  private publishState(): void {
    if (!this.liveContents()) return
    this.handlers.onState(this.getState())
  }
}
