// User-run only: node --test tests/github-login-progress.test.mjs
// Pure presentation logic with task snapshots. No Electron, gh or network.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { Script } from 'node:vm'
import ts from 'typescript'

const exports = {}
new Script(ts.transpileModule(readFileSync(new URL('../src/renderer/src/github-login-progress.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText).runInNewContext({ exports })
const { githubLoginProgress, isGithubLoginTask } = exports
const task = patch => ({ id: 'login-task', command: "& 'C:/Program Files/GitHub CLI/gh.exe' auth login --web",
  conversationId: 'chat-1', createdAt: 101, transport: 'local', status: 'running',
  output: '', errorOutput: '', message: '', exitCode: null, ...patch })

test('login progress binds only to the current attempt, local target and conversation', () => {
  assert.equal(isGithubLoginTask(task(), 'chat-1', 100), true)
  for (const patch of [{ transport: 'ssh' }, { conversationId: 'chat-2' }, { createdAt: 99 }, { command: 'gh repo list' }]) {
    assert.equal(isGithubLoginTask(task(patch), 'chat-1', 100), false)
  }
})

test('creation, device authorization on stderr, completion and failures have distinct states', () => {
  assert.equal(githubLoginProgress(undefined, null, true).label, 'AI 正在准备登录…')
  assert.equal(githubLoginProgress(task(), null, true).label, '正在发起授权…')
  assert.equal(githubLoginProgress(task({ errorOutput: 'https://github.com/login/device ABCD-1234' }), null, true).label, '等待你完成 GitHub 授权')
  assert.equal(githubLoginProgress(task({ status: 'completed', exitCode: 0 }), null, true).label, '正在确认登录状态…')
  assert.match(githubLoginProgress(task({ status: 'failed', exitCode: 7 }), null, true).message, /退出码 7/)
  assert.equal(githubLoginProgress(task({ status: 'unknown', message: 'connection lost' }), null, true).message, 'connection lost')
  assert.equal(githubLoginProgress(undefined, null, false).error, true)
})

test('format recovery overrides the generic task spinner and cannot claim authorization success', () => {
  for (const status of ['pending', 'sent', 'blocked', 'failed', 'uncertain']) {
    const progress = githubLoginProgress(undefined, { status, message: 'specific recovery state' }, true)
    assert.equal(progress.message, 'specific recovery state')
    assert.equal(progress.error, !['pending', 'sent'].includes(status))
    assert.equal(progress.label.includes('成功'), false)
  }
})
