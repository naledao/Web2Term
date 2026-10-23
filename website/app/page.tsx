'use client'

import { useState } from 'react'
import Web2termWordmark from './components/Web2termWordmark'
import {
  assetPath,
  PRODUCT_NAME,
  LATEST_RELEASE_URL,
  WINDOWS_DOWNLOAD_URL,
  MACOS_DOWNLOAD_URL,
  MACOS_INSTALLATION_GUIDE_URL,
  LINUX_AGENT_DOWNLOAD_URL,
  LINUX_AGENT_CHECKSUM_URL,
  WEB2TERM_GUIDE_URL,
  LINUX_AGENT_GUIDE_URL,
} from './site-config'

type Step = {
  eyebrow: string
  title: string
  body: string
  command: string
  result: string
  tone: string
}

const steps: Step[] = [
  {
    eyebrow: '01 / INTENT',
    title: '把目标交给熟悉的模型。',
    body: '继续使用 ChatGPT、Claude、Gemini 或 DeepSeek。对话留在你已经习惯的界面里，工作区负责把上下文带到下一步。',
    command: '“检查这个项目为什么构建变慢。”',
    result: '模型读懂目标，开始提出可执行的检查。',
    tone: 'gold',
  },
  {
    eyebrow: '02 / COMMAND',
    title: '每条命令都在你眼前。',
    body: '终端自动捕获模型提出的下一条命令。你可以手动执行，也可以让它按步骤推进，随时暂停或结束任务。',
    command: '› npm run build -- --profile',
    result: '命令进入选定的本机、SSH 或 web2term 设备。',
    tone: 'blue',
  },
  {
    eyebrow: '03 / RESULT',
    title: '结果回到同一段对话。',
    body: '退出码、输出和状态会回传给模型。它看见刚刚发生的事，下一步建议不再依赖猜测。',
    command: '✓ exit 0  ·  18.4s  ·  0 errors',
    result: '从“试试看”变成可检查、可继续的工作流。',
    tone: 'mint',
  },
]

const features = [
  {
    title: '按项目组织对话，共享补充说明',
    body: '为项目设置本机目录，将相关对话放在一起。项目内共享 Markdown 补充说明，新建本机会话从项目目录开始。',
    tag: 'PROJECT CONTEXT',
  },
  {
    title: '专注当前任务，也能在侧边追问',
    body: 'ChatGPT 和 DeepSeek 可切换专注对话，集中查看回答、思考与执行过程。四个平台均支持侧边聊天和选区追问，沿用各自的登录态。',
    tag: 'FOCUS + SIDE CHAT',
  },
  {
    title: '让模型读取文件，直接查看原内容',
    body: '将本机或 SSH 主机上的源码、图片和文档作为完整附件发送。每次最多 3 个文件，单个 20 MiB、合计 25 MiB；Web2Term 设备连接暂未接入。',
    tag: 'FILE ATTACHMENTS',
  },
  {
    title: '长任务放到后台，结果自动回来',
    body: '软件负责启动和监控非交互后台任务，保留 PID、日志和退出码，向原对话发送创建通知与最终结果。主终端可以继续工作，关闭任务页签仍保留监控。',
    tag: 'BACKGROUND TASKS',
  },
  {
    title: '给自己多开一个独立终端',
    body: '从右侧「＋」新增本机、SSH 或设备终端，手动检查当前环境。它有自己的 Shell，输出不会自动发送给模型；模型终端仍按手动或自动模式推进。',
    tag: 'PERSONAL TERMINALS',
  },
  {
    title: '浏览 GitHub 仓库，克隆到本机',
    body: '使用本机 GitHub CLI 账号搜索、筛选和排序仓库，选择目录克隆并查看进度。可让当前 AI 协助登录；此入口需要本机安装 GitHub CLI。',
    tag: 'GITHUB REPOSITORIES',
  },
]

const toolboxTools = [
  {
    id: 'git',
    name: 'Git 管理',
    summary: '文件差异与提交记录',
    title: '看清改了哪里，也看清怎么改过来。',
    body: '浏览本机或 SSH 远端项目的文件改动，切换统一或并排 diff，沿提交图查看分支、标签与历史记录。',
    scope: '面板只读，提交和切换分支通过终端执行。Web2Term 设备连接暂未接入 Git 面板。',
  },
  {
    id: 'mysql',
    name: 'MySQL 连接',
    summary: '数据编辑、SQL 与结构导出',
    title: '从数据库，看到表里的具体数据。',
    body: '保存多个连接，搜索表名与注释，查看数据和 DDL；按主键编辑字段、单条或批量删除记录，创建与删除表、导出表结构，也可执行单条 SQL。',
    scope: '查询最多展示 200 行。修改直接作用于数据库，展示行数上限不限制写入 SQL 的影响范围。',
  },
  {
    id: 'redis',
    name: 'Redis 连接',
    summary: '只读浏览键、值与 TTL',
    title: '找到一个键，读懂它现在的状态。',
    body: '测试并保存连接，切换数据库、搜索键名，查看数据类型和 TTL。支持 String、Hash、List、Set、ZSet 与 Stream，以及字符串的 JSON 格式化。',
    scope: '只读浏览，按批次加载键与数据。当前不支持 Redis Cluster。',
  },
  {
    id: 'nacos',
    name: 'Nacos 连接',
    summary: '保存连接与内置控制台',
    title: '把常用的控制台，留在工作区里。',
    body: '为不同环境保存名称、控制台地址与命名空间，在独立页签中打开 Nacos 控制台，继续使用它的配置管理与服务发现界面。',
    scope: '控制台使用 Nacos 自身的登录与权限。',
  },
] as const

type ToolboxId = (typeof toolboxTools)[number]['id']

const modelPlatforms = [
  {
    id: 'chatgpt',
    name: 'ChatGPT',
    icon: '/models/chatgpt.svg',
    detail: '内置网页会话 · 独立登录态',
    tone: 'blue',
  },
  {
    id: 'claude',
    name: 'Claude',
    icon: '/models/claude.svg',
    detail: '内置网页会话 · 独立登录态',
    tone: 'amber',
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    icon: '/models/deepseek.svg',
    detail: '内置网页会话 · 独立登录态',
    tone: 'mint',
  },
  {
    id: 'gemini',
    name: 'Gemini',
    icon: '/models/gemini.svg',
    detail: '内置网页会话 · 独立登录态',
    tone: 'violet',
  },
]

function ArrowIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M2.5 8h10M8.5 4l4 4-4 4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function DownloadIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M8 2.5v7M5.25 7.75 8 10.5l2.75-2.75M3 12.5h10" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function TerminalIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <rect x="2.3" y="3.1" width="15.4" height="13.8" rx="2.4" fill="none" stroke="currentColor" strokeWidth="1.35" />
      <path d="m5.3 7.2 2.4 2.3-2.4 2.3M9.4 12h4.1" fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function Mark() {
  return <img className="brand-mark" src={assetPath('/brand-icon.png')} alt="" aria-hidden="true" />
}

function ToolboxPreview({ tool }: { tool: ToolboxId }) {
  if (tool === 'git') {
    return (
      <div className="tool-preview tool-preview--git">
        <div className="tool-preview__bar"><code>main</code><span>文件改动 · 统一 diff</span></div>
        <p className="tool-preview__path">src/config.ts</p>
        <pre className="tool-preview__diff"><code><span className="diff-line diff-line--removed">- const executionTarget = &apos;local&apos;</span><span className="diff-line diff-line--added">+ const executionTarget = &apos;web2term&apos;</span></code></pre>
        <div className="tool-preview__foot">文件改动与提交记录，在同一处查看。</div>
      </div>
    )
  }
  if (tool === 'mysql') {
    return (
      <div className="tool-preview tool-preview--mysql">
        <div className="tool-preview__bar"><code>app.projects</code><span>表数据 / DDL</span></div>
        <p className="tool-preview__query"><code>SELECT * FROM `app`.`projects` LIMIT 201</code></p>
        <div className="tool-preview__table-scroll">
          <table><caption>项目表 · 示例数据</caption><thead><tr><th scope="col">id<small>项目编号</small></th><th scope="col">name<small>项目名称</small></th><th scope="col">environment<small>运行环境</small></th></tr></thead><tbody><tr><td>1</td><td>web-api</td><td>staging</td></tr><tr><td>2</td><td>worker</td><td>production</td></tr></tbody></table>
        </div>
      </div>
    )
  }
  if (tool === 'redis') {
    return (
      <div className="tool-preview tool-preview--redis">
        <div className="tool-preview__bar"><code>DB 0</code><span>只读浏览</span></div>
        <dl className="redis-example"><div><dt>键名</dt><dd><code>app:config</code></dd></div><div><dt>类型</dt><dd><code>string</code></dd></div><div><dt>TTL</dt><dd>不过期</dd></div></dl>
        <pre className="tool-preview__json"><code>{'{\n  "environment": "staging",\n  "feature_enabled": true\n}'}</code></pre>
        <div className="tool-preview__foot">JSON 格式化预览 · TTL 为最近一次读取时的值</div>
      </div>
    )
  }
  return (
    <div className="tool-preview tool-preview--nacos">
      <div className="tool-preview__bar"><span>Nacos 控制台连接</span><span>独立页签</span></div>
      <dl className="nacos-example"><div><dt>连接名称</dt><dd>本地开发</dd></div><div><dt>控制台地址</dt><dd><code>http://localhost:8848/nacos</code></dd></div><div><dt>命名空间</dt><dd><code>public</code></dd></div></dl>
      <div className="tool-preview__foot">保存连接信息后，在工作区内打开控制台。</div>
    </div>
  )
}

export default function Home() {
  const [activeStep, setActiveStep] = useState(1)
  const [menuOpen, setMenuOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  const [activeTool, setActiveTool] = useState<ToolboxId>('redis')
  const step = steps[activeStep]
  const tool = toolboxTools.find((item) => item.id === activeTool)!

  const scrollTo = (id: string) => {
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    document.getElementById(id)?.scrollIntoView({ behavior: reducedMotion ? 'instant' : 'smooth', block: 'start' })
    setMenuOpen(false)
  }

  const copyCommand = async () => {
    try {
      await navigator.clipboard.writeText('npm run build -- --profile')
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1800)
    } catch {
      setCopied(false)
    }
  }

  return (
    <main className="site-shell">
      <div className="ambient ambient--left" aria-hidden="true" />
      <div className="ambient ambient--right" aria-hidden="true" />

      <header className="site-header">
        <button className="brand" onClick={() => scrollTo('top')} aria-label={`${PRODUCT_NAME}，回到首页`}>
          <Mark />
          <span className="brand-wordmark"><Web2termWordmark /></span>
        </button>
        <button className="menu-toggle" onClick={() => setMenuOpen((open) => !open)} aria-expanded={menuOpen} aria-controls="site-navigation" aria-label={menuOpen ? '关闭导航' : '打开导航'}>
          <span />
          <span />
        </button>
        <nav id="site-navigation" className={menuOpen ? 'site-nav site-nav--open' : 'site-nav'} aria-label="主导航">
          <button onClick={() => scrollTo('models')}>AI 平台</button>
          <button onClick={() => scrollTo('workflow')}>工作流</button>
          <button onClick={() => scrollTo('macos')}>macOS</button>
          <button onClick={() => scrollTo('web2term')}>Linux 设备</button>
          <button onClick={() => scrollTo('toolbox')}>工具箱</button>
          <button onClick={() => scrollTo('download')}>下载</button>
          <button className="nav-cta" onClick={() => scrollTo('download')}>
            开始使用 <ArrowIcon />
          </button>
        </nav>
      </header>

      <section className="hero" id="top">
        <div className="hero-copy">
          <p className="hero-overline"><span className="live-dot" /> AI × 本机与远程终端</p>
          <h1>让对话<br /><em>抵达终端。</em></h1>
          <p className="hero-lede">{PRODUCT_NAME} 把模型网页、项目对话与本机、SSH、Linux 设备上的命令执行放进同一个工作区。专注当前任务，让后台任务、GitHub 仓库和数据库工具随手可用。</p>
          <div className="hero-actions">
            <a className="button button--primary" href={WINDOWS_DOWNLOAD_URL} download>下载 Windows 版 <DownloadIcon /></a>
            <a className="button button--secondary" href={MACOS_DOWNLOAD_URL} download>下载 macOS 版 <DownloadIcon /></a>
            <button className="text-link" onClick={() => scrollTo('workflow')}>先看它怎么工作 <ArrowIcon /></button>
          </div>
          <div className="platform-note"><span>Windows x64</span><i aria-hidden="true" /><span>macOS Apple Silicon</span><small>· GitHub 最新 Release</small></div>
        </div>

        <div className="hero-demo" aria-label="对话到终端的工作流演示">
          <div className="sun-halo sun-halo--one" />
          <div className="sun-halo sun-halo--two" />
          <div className="hero-demo__topline"><span>WORKSPACE / 功能示意</span><span><i className="status-dot" /> LOCAL · C:\\project</span></div>
          <div className="hero-demo__body">
            <div className="demo-sidebar">
              <span className="demo-sidebar__label">SESSIONS</span>
              <div className="session session--active"><span className="session-pulse" /><span>Build profile</span><small>now</small></div>
              <div className="session"><span className="session-line" /><span>SSH · staging</span><small>2m</small></div>
              <div className="session"><span className="session-line" /><span>web2term · dev-linux</span><small>1h</small></div>
              <div className="demo-sidebar__foot"><span className="avatar">K</span><span>workspace</span></div>
            </div>
            <div className="demo-main">
              <div className="demo-main__title"><span>对话</span><span className="demo-mode">TERMINAL MODE <b>ON</b></span></div>
              <div className="chat-line chat-line--human"><span className="chat-avatar">K</span><p>查一下这个项目的构建时间，顺便找出最慢的步骤。</p></div>
              <div className="chat-line chat-line--model"><span className="model-avatar"><TerminalIcon /></span><div><p>我先运行一次带 profile 的构建，拿到真实数据。</p><div className="command-line"><span>›</span><code>npm run build -- --profile</code><button onClick={copyCommand} aria-label="复制命令">{copied ? '已复制' : '复制'}</button></div></div></div>
              <div className="demo-terminal"><div className="demo-terminal__head"><span><i className="term-dot term-dot--red" /><i className="term-dot term-dot--yellow" /><i className="term-dot term-dot--green" /></span><span>OUTPUT / 18.4s</span></div><div className="terminal-lines"><p><span className="dim">01</span> vite v7.3.6 building for production...</p><p><span className="dim">02</span> transforming <b>128 modules</b></p><p><span className="dim">03</span> rendering chunks...</p><p className="terminal-success"><span className="dim">04</span> ✓ built in 18.4s</p></div></div>
            </div>
          </div>
          <div className="hero-demo__caption"><span><b>01</b> 目标</span><span className="caption-line" /><span><b>02</b> 命令</span><span className="caption-line" /><span><b>03</b> 结果回传</span></div>
        </div>
      </section>

      <section className="model-deck" id="models" aria-labelledby="models-title">
        <div className="model-deck__intro">
          <p className="section-mark">MODEL ROUTES</p>
          <h2 id="models-title">你可以选择<br /><span>哪一个 AI。</span></h2>
          <p>不绑定单一模型。把你已经在用的 AI 带进同一个终端工作区，让对话、命令和结果沿着同一条线继续。</p>
          <div className="model-deck__count"><strong>04</strong><span>可用 AI 平台</span></div>
        </div>
        <div className="model-deck__list">
          {modelPlatforms.map((model, index) => (
            <article className={`model-entry model-entry--${model.tone}`} key={model.id}>
              <span className="model-entry__index">0{index + 1}</span>
              <span className="model-entry__icon"><img src={assetPath(model.icon)} alt="" /></span>
              <span className="model-entry__copy"><strong>{model.name}</strong><small>{model.detail}</small></span>
              <ArrowIcon />
            </article>
          ))}
          <p className="model-deck__note"><span className="status-dot" /> 四个平台都可在工作区内直接登录，Gemini 使用 Google 账号登录即可。</p>
        </div>
      </section>

      <section className="workflow section" id="workflow">
        <div className="section-intro">
          <p className="section-mark">THE LOOP</p>
          <h2>从一句话，<br /><span>走到一个结果。</span></h2>
          <p>没有黑箱，也不需要记住下一步该去哪里。工作区把一次任务拆成看得见的三个瞬间。</p>
        </div>
        <div className="workflow-panel">
          <div className="workflow-tabs" role="tablist" aria-label="工作流步骤">
            {steps.map((item, index) => <button key={item.eyebrow} role="tab" aria-selected={activeStep === index} className={activeStep === index ? 'workflow-tab workflow-tab--active' : 'workflow-tab'} onClick={() => setActiveStep(index)}><span>{item.eyebrow}</span><strong>{item.title.replace('。', '')}</strong></button>)}
          </div>
          <div className={`workflow-detail workflow-detail--${step.tone}`}>
            <div className="workflow-detail__copy"><p className="detail-overline">{step.eyebrow}</p><h3>{step.title}</h3><p>{step.body}</p><div className="detail-result"><span className="result-mark">↳</span><span>{step.result}</span></div></div>
            <div className="workflow-detail__terminal"><span className="terminal-label">LIVE TRANSCRIPT</span><p className="terminal-prompt">{step.command}</p><div className="terminal-cursor" /></div>
          </div>
        </div>
      </section>

      <section className="connections macos-support section" id="macos" aria-labelledby="macos-title">
        <div className="connections-intro">
          <p className="section-mark">MACOS / APPLE SILICON</p>
          <h2 id="macos-title">在 Mac 上，<br /><span>继续同一个工作流。</span></h2>
          <p>用 Mac 自带的 zsh 执行命令，把模型对话、终端结果和常用工具留在一个工作区。当前 DMG 适用于 Apple Silicon（M 系列芯片）。</p>
          <dl className="macos-features">
            <div><dt>持久的本机终端</dt><dd>当前目录、变量与函数在同一终端会话中保留，下一条命令接着上一步继续。</dd></div>
            <div><dt>适配 macOS 的命令</dt><dd>识别系统与 Shell 环境，按 macOS 命令语法生成提示词；使用 Homebrew 前先检查是否已安装。</dd></div>
            <div><dt>远程与工具箱，继续可用</dt><dd>连接 SSH 或 web2term 设备，使用 Git、MySQL、Redis 与 Nacos。数据库和控制台地址需可从这台 Mac 访问。</dd></div>
          </dl>
          <div className="connection-actions">
            <a className="button button--primary" href={MACOS_DOWNLOAD_URL} download>下载 macOS · Apple Silicon <DownloadIcon /></a>
            <a className="text-link" href={MACOS_INSTALLATION_GUIDE_URL} target="_blank" rel="noreferrer">完整安装说明 <ArrowIcon /></a>
          </div>
          <details className="connection-notes">
            <summary>系统终端能运行，工作区却找不到命令？</summary>
            <ul>
              <li>应用本机终端使用非交互的 zsh 登录会话，标准输入为空。外部命令需已安装并在这个会话的 PATH 中。</li>
              <li>仅在 <code>~/.zshrc</code> 中设置的交互配置不保证加载。可将 PATH 配置放在 <code>~/.zprofile</code> 中，修改后重置终端。</li>
              <li>需要输入密码的 sudo 或交互式程序，请在系统“终端”中手动运行。</li>
            </ul>
          </details>
        </div>
        <div className="connection-guide">
          <ol className="connection-steps">
            <li>
              <h3>下载 Apple Silicon 安装包</h3>
              <p>适用于 M 系列芯片的 Mac，选择 DMG 安装包。当前发布流程尚未提供 Intel Mac 版本。</p>
            </li>
            <li>
              <h3>拖入“应用程序”</h3>
              <p>打开 DMG，将 <strong>{PRODUCT_NAME} 桌面应用</strong> 拖入“应用程序”，然后从这里打开。使用安装包无需另装 Node.js、npm 或 PowerShell。</p>
            </li>
            <li>
              <h3>首次打开，按系统提示处理</h3>
              <p>当前应用使用 ad-hoc 签名，没有 Developer ID 签名或 Apple 公证。若提示无法验证开发者，可按安装说明在“系统设置 → 隐私与安全性”中选择“仍要打开”。</p>
              <div className="connection-actions"><a className="text-link" href={MACOS_INSTALLATION_GUIDE_URL} target="_blank" rel="noreferrer">查看首次打开与“已损坏”提示的处理步骤 <ArrowIcon /></a></div>
            </li>
          </ol>
          <p className="connection-scope"><strong>后续更新：</strong>应用内可检查新版本，点击下载会在浏览器中打开最新 DMG。下载后退出应用，再将新版本拖入“应用程序”覆盖旧版本。</p>
        </div>
      </section>

      <section className="connections section" id="web2term" aria-labelledby="web2term-title">
        <div className="connections-intro">
          <h2 id="web2term-title">你的 Linux 设备，<br /><span>接进同一段对话。</span></h2>
          <p>{PRODUCT_NAME} 桌面客户端与 Linux 小工具主动连接同一后端，登录同一账号后即可选择设备。继续手动输入命令、让模型执行并接收结果，无需设备运行 SSH 服务。</p>
          <p className="connections-platform">Windows / macOS 桌面端 + Linux x86_64 设备工具</p>
          <a className="text-link" href={WEB2TERM_GUIDE_URL} target="_blank" rel="noreferrer">查看桌面连接指南 <ArrowIcon /></a>
          <details className="connection-notes">
            <summary>连接前要知道</summary>
            <ul>
              <li>同一设备最多同时运行 3 个 PTY，模型终端、附加终端和后台任务观察通道共享名额。每个工作区的手动输入与模型命令共用 Shell。</li>
              <li>当前桌面端共享一条设备连接。切换设备会断开原设备通道，原会话保留历史，可手动重新连接。</li>
              <li>小工具对可恢复的网络故障自动重连，但原终端 Shell 不恢复；客户端需重新连接并创建终端，命令不会自动改到本机执行。</li>
            </ul>
          </details>
        </div>
        <div className="connection-guide">
          <ol className="connection-route" aria-label="web2term 连接路径">
            <li><strong>桌面工作区</strong><span>选择账号下的设备</span><ArrowIcon /></li>
            <li><strong>后端服务</strong><span>两端使用同一账号</span><ArrowIcon /></li>
            <li><strong>Linux 设备</strong><span>web2term 提供终端</span></li>
          </ol>
          <ol className="connection-steps">
            <li>
              <h3>在设备上安装并启动工具</h3>
              <p>下载 Linux x86_64 工具与校验文件，确认 SHA-256 校验通过后安装到 PATH。配置后端地址并完成邮箱验证码登录，再用同一 Linux 用户启动后台进程。</p>
              <pre className="connection-commands" aria-label="Linux 设备校验、安装与启动命令"><code>{'sha256sum -c web2term-linux-amd64.sha256 &&\n  sudo install -m 0755 web2term-linux-amd64 /usr/local/bin/web2term\nweb2term set server\nweb2term login\nweb2term run\nweb2term status'}</code></pre>
              <p>当 <code>web2term status</code> 显示设备已在线、服务端已确认心跳时，再到桌面端连接。</p>
              <p><code>run</code> 启动后返回，关闭终端或断开 SSH 后仍继续运行；使用 <code>web2term stop</code> 停止。客户端“设置 → web2term 设备”也提供带校验的工具下载。</p>
              <div className="connection-actions"><a className="text-link" href={LINUX_AGENT_DOWNLOAD_URL} download>下载 Linux 工具 <DownloadIcon /></a><a className="text-link" href={LINUX_AGENT_CHECKSUM_URL} download>SHA-256 校验文件 <DownloadIcon /></a><a className="text-link" href={LINUX_AGENT_GUIDE_URL} target="_blank" rel="noreferrer">工具使用说明 <ArrowIcon /></a></div>
            </li>
            <li><h3>在桌面端登录同一后端与账号</h3><p>打开 <strong>设置 → 后端服务</strong>，填写与设备工具一致的后端地址并登录。</p></li>
            <li><h3>选择设备，等待终端就绪</h3><p>点击会话栏 <strong>＋ → web2term</strong>，在“我的设备”中选择在线且已启用的设备。终端就绪后，即可直接输入命令或让模型执行；“设置 → web2term 设备”可修改设备名称。</p></li>
            <li>
              <h3>需要开机上线？启用 systemd 自启</h3>
              <p>在已登录的同一 Linux 用户下执行，工具按需请求 sudo 权限，系统服务仍以原用户运行并沿用设备身份。</p>
              <pre className="connection-commands" aria-label="Linux systemd 开机自启命令"><code>{'web2term autostart enable\nweb2term autostart status\nweb2term status\nweb2term autostart disable'}</code></pre>
              <p>不要在 <code>autostart enable</code> 前另加 sudo。首次切换到服务托管会关闭现有终端，需重新连接；<code>stop</code> 保留自启设置，<code>autostart disable</code> 才会关闭后续开机启动。仅支持启用 systemd 的 Linux 主机。</p>
            </li>
          </ol>
          <p className="connection-scope">设备连接支持命令执行、后台任务与结果回传；文件浏览、上传下载、AI 文件附件读取和 Git 面板暂未接入。读取文件或操作 Git 可使用终端命令。升级小工具时先停止旧进程，替换二进制后再启动。</p>
        </div>
      </section>

      <section className="capabilities section" id="capabilities">
        <div className="capabilities-heading"><p className="section-mark">THE WORKSPACE</p><h2>把上下文<br /><span>留在手边。</span></h2></div>
        <div className="feature-rail">{features.map((feature, index) => <article className="feature-row" key={feature.tag}><span className="feature-index">0{index + 1}</span><div className="feature-content"><p>{feature.tag}</p><h3>{feature.title}</h3><span>{feature.body}</span></div><ArrowIcon /></article>)}</div>
      </section>

      <section className="toolbox section" id="toolbox" aria-labelledby="toolbox-title">
        <div className="toolbox-heading"><h2 id="toolbox-title">代码、数据、配置，<br /><span>工具箱就在手边。</span></h2><p>从右侧页签打开“工具箱”，在可最小化、恢复的工具窗口中查看改动、编辑表数据、查询缓存或打开配置控制台。GitHub 仓库管理从旁边的“＋”进入。</p></div>
        <div className="toolbox-workbench">
          <div className="toolbox-selector" role="group" aria-label="选择工具箱功能">
            {toolboxTools.map((item) => (
              <button type="button" key={item.id} className={activeTool === item.id ? 'toolbox-choice toolbox-choice--active' : 'toolbox-choice'} aria-pressed={activeTool === item.id} aria-controls="toolbox-detail" onClick={() => setActiveTool(item.id)}><span><strong>{item.name}</strong><small>{item.summary}</small></span><ArrowIcon /></button>
            ))}
          </div>
          <div className="toolbox-detail" id="toolbox-detail" role="region" aria-labelledby="toolbox-detail-title" aria-live="polite">
            <div className="toolbox-detail__header"><span>{tool.name}</span><small>功能示意 · 示例数据</small></div>
            <h3 id="toolbox-detail-title">{tool.title}</h3>
            <p className="toolbox-detail__body">{tool.body}</p>
            <ToolboxPreview tool={activeTool} />
            <p className="toolbox-detail__scope">{tool.scope}</p>
          </div>
        </div>
        <p className="toolbox-note">MySQL、Redis 与 Nacos 从运行客户端的电脑发起连接，不自动经过 SSH 隧道或 Web2Term 设备。127.0.0.1 指向这台电脑；SSH Git 面板通过远端命令通道读取仓库。</p>
      </section>

      <section className="preview section">
        <div className="preview-heading"><p className="section-mark">A REAL WINDOW</p><h2>围绕一个目标，<br /><span>展开整个工作区。</span></h2><p>左侧按项目组织对话，中间是 ChatGPT 专注对话，右侧集中执行控制与补充说明。终端、工具箱和后台任务都从同一处进入。</p></div>
        <div className="preview-frame"><div className="preview-frame__top"><span className="preview-dots"><i /><i /><i /></span><span>{PRODUCT_NAME}</span><span className="preview-shortcut">Windows / 专注对话</span></div><img src={assetPath('/workspace.png')} alt="Web2Term 工作区：左侧项目与对话列表，中间 ChatGPT 专注对话，右侧执行控制和 Markdown 补充说明" width="2560" height="1493" loading="lazy" /></div>
      </section>

      <section className="download section" id="download">
        <div className="download-orbit" aria-hidden="true"><span /><span /><span /></div>
        <div className="download-copy">
          <p className="section-mark">YOUR NEXT SESSION</p>
          <h2>把下一次<br /><span>工作跑起来。</span></h2>
          <p>下载 Windows 或 macOS 桌面版，登录你已经在用的模型，选择本机、SSH 或 web2term 设备。需要连接 Linux 设备时，再安装配套的 web2term 工具。</p>
          <div className="download-actions">
            <a className="button button--primary" href={WINDOWS_DOWNLOAD_URL} download>下载 Windows 版 <DownloadIcon /></a>
            <a className="button button--secondary" href={MACOS_DOWNLOAD_URL} download>下载 macOS · Apple Silicon <DownloadIcon /></a>
            <a className="text-link" href={LATEST_RELEASE_URL} target="_blank" rel="noreferrer">查看 Release 说明 <ArrowIcon /></a>
            <a className="text-link" href={LINUX_AGENT_DOWNLOAD_URL} download>下载 web2term · Linux x86_64 <DownloadIcon /></a>
          </div>
          <small>桌面端：Windows x64 / macOS arm64 · 设备工具：Linux x86_64 · 下载源：GitHub 最新 Release</small>
        </div>
        <div className="download-terminal"><div className="download-terminal__head"><span>SESSION SETUP</span><span>工作区入口</span></div><dl className="download-environments"><div><dt>本机终端</dt><dd>Windows · PowerShell / macOS · zsh</dd></div><div><dt>远程连接</dt><dd>SSH / web2term</dd></div><div><dt>工具箱</dt><dd>Git / MySQL / Redis / Nacos</dd></div><div><dt>模型</dt><dd>ChatGPT / Claude / Gemini / DeepSeek</dd></div></dl></div>
      </section>

      <footer className="site-footer"><div className="footer-brand"><Mark /><div><strong>{PRODUCT_NAME}</strong><span>CONVERSATION, MEET EXECUTION.</span></div></div><div className="footer-links"><button onClick={() => scrollTo('models')}>AI 平台</button><button onClick={() => scrollTo('workflow')}>工作流</button><button onClick={() => scrollTo('macos')}>macOS 安装</button><button onClick={() => scrollTo('web2term')}>Linux 设备</button><button onClick={() => scrollTo('toolbox')}>工具箱</button><button onClick={() => scrollTo('download')}>下载</button><a href={WINDOWS_DOWNLOAD_URL} download>Windows 下载 <ArrowIcon /></a><a href={MACOS_DOWNLOAD_URL} download>macOS 下载 <ArrowIcon /></a></div><span className="footer-note">© 2026 · Built for the next command.</span></footer>
    </main>
  )
}




