// User-run offline logger regression; temporary fixture files only.
// Run: node --test tests/git-diagnostic.test.mjs
import assert from 'node:assert/strict'
import * as crypto from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { test } from 'node:test'
import { Script } from 'node:vm'
import ts from 'typescript'

const exports = {}
const dependencies = { 'node:crypto': crypto, 'node:fs': fs, 'node:os': os, 'node:path': path }
new Script(ts.transpileModule(fs.readFileSync(new URL('../src/main/git-diagnostic.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText).runInNewContext({
  exports, Buffer, process,
  require(name) { assert.ok(name in dependencies); return dependencies[name] }
})
const { GitDiagnosticLog, createGitDiagnostic } = exports

test('logging is lazy, rotates at the configured size, and whitelists fields', () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'git-diagnostic-test-'))
  try {
    const directory = path.join(fixture, 'logs')
    const logger = new GitDiagnosticLog(directory, 500)
    assert.equal(fs.existsSync(directory), false)
    const context = { ...createGitDiagnostic('ssh', 'files'), stage: 'status', cwd: '/private/repository', args: ['secret'] }
    for (let i = 0; i < 6; i++) {
      assert.ok(logger.write(context, {
        event: 'ssh-finish', status: 'timeout', elapsedMs: 60000,
        channelWaitMs: 50, executionMs: 59950, bytes: 100, exitCode: null,
        output: 'private file contents', error: 'secret path'
      }))
    }
    const files = fs.readdirSync(directory)
    assert.ok(files.length > 1)
    const lines = files.flatMap((name) => {
      const filename = path.join(directory, name)
      assert.ok(fs.statSync(filename).size <= 500)
      const text = fs.readFileSync(filename, 'utf8')
      assert.doesNotMatch(text, /private|secret|repository|args|output|contents/)
      return text.trim().split('\n')
    })
    assert.equal(lines.length, 6)
    const metadata = JSON.parse(lines[0].slice(lines[0].indexOf('{')))
    assert.equal(metadata.requestId, context.requestId)
    assert.equal(metadata.channelWaitMs, 50)
    assert.equal(metadata.executionMs, 59950)
    assert.equal(metadata.status, 'timeout')
    assert.equal(logger.write({ ...context, requestId: '/private/path' }, { event: 'stage-start' }), null)
  } finally { fs.rmSync(fixture, { recursive: true, force: true }) }
})

test('an unavailable log directory cannot interrupt Git operations', () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'git-diagnostic-test-'))
  try {
    const filename = path.join(fixture, 'ordinary-file')
    fs.writeFileSync(filename, 'fixture')
    const logger = new GitDiagnosticLog(path.join(filename, 'invalid-child'))
    assert.equal(logger.write(createGitDiagnostic('local', 'history'), { event: 'request-start' }), null)
  } finally { fs.rmSync(fixture, { recursive: true, force: true }) }
})
