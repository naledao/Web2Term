// User-run only: node --test tests/computer-delivery-classification.test.mjs
// Extracted actual transport functions with synthetic upload stages, pages and receipts.
// No Electron, browser, filesystem preparation, desktop, shell or network is used.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { Script } from 'node:vm'
import { test } from 'node:test'
import ts from 'typescript'
const compile = source => ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
const source = path => ts.createSourceFile(path, readFileSync(new URL(path, import.meta.url), 'utf8'), ts.ScriptTarget.ES2022, true)
function find(root, predicate) { let match; function visit(node) { if (!match && predicate(node)) match = node; if (!match) ts.forEachChild(node, visit) } visit(root); assert.ok(match); return match }

test('only proven failures before submit receive a retryable computer delivery outcome', () => {
  const ast = source('../src/main/page-files.ts'), node = find(ast, node => ts.isVariableDeclaration(node) && node.name.getText(ast) === 'finish')
  const classify = (stage, submitted, outcome, computer = true) => new Script(compile(`const finish = ${node.initializer.getText(ast)}; finish(outcome, 'synthetic')`)).runInNewContext({
    stage, submitted, outcome, options: { computerResult: computer ? {} : undefined }, platformId: 'deepseek', token: 'synthetic',
    diagnosticLogPaths: new Map(), log() {}, console: { warn() {} }
  })
  assert.equal(classify('upload', false, 'upload-failed'), 'not-submitted')
  assert.equal(classify('caption', false, 'upload-failed'), 'not-submitted')
  assert.equal(classify('submit', false, 'upload-failed'), 'upload-failed', 'a lost submit response is not proof of non-submission')
  assert.equal(classify('submit', true, 'unknown'), 'unknown')
  assert.equal(classify('begin', false, 'busy'), 'busy')
  assert.equal(classify('upload', false, 'busy'), 'unknown')
  assert.equal(classify('upload', false, 'upload-failed', false), 'upload-failed', 'ordinary file transport retains its prior outcome')
})

test('observation transport distinguishes a safe upload failure from an uncertain submission', async () => {
  const ast = source('../src/main/embed.ts'), node = find(ast, node => ts.isMethodDeclaration(node) && node.name.getText(ast) === 'sendTaskObservation')
  let outcome = 'not-submitted'
  const Subject = new Script(compile(`class Subject { ${node.getText(ast)} }\nSubject`)).runInNewContext({ URL, sendPageFiles: async () => outcome })
  const subject = Object.assign(new Subject(), { taskPromptGeneration: 1, platform: { id: 'deepseek', homeUrl: 'https://chat.deepseek.com/', conversationIdFromPath: () => 'chat-a' },
    liveContents: () => ({ getURL: () => 'https://chat.deepseek.com/a/chat/s/chat-a', isDestroyed: () => false }) })
  for (const [value, expected] of [['not-submitted', 'failed'], ['upload-failed', 'unknown'], ['unknown', 'unknown'], ['busy', 'busy'], ['ok', 'ok']]) {
    outcome = value
    assert.equal(await subject.sendTaskObservation('saved result', 'chat-a', new AbortController().signal, [{}], 'image', () => true), expected)
  }
})

test('failure preparing a saved image is known to precede submission and does not invoke the page sender', async () => {
  const ast = source('../src/main/session-runtime.ts')
  const creation = find(ast, node => ts.isNewExpression(node) && node.expression.getText(ast) === 'TaskProgression')
  const send = creation.arguments[0].properties.find(node => node.name?.getText(ast) === 'send').initializer
  let pageCalls = 0, current = true
  const options = { computerUseObservations: { prepare: async () => { throw new Error('synthetic missing capture') } } }
  const Subject = new Script(compile(`class Subject { send = ${send.getText(ast)} }\nSubject`)).runInNewContext({ options })
  const subject = Object.assign(new Subject(), { taskCoordinator: { owns: () => current },
    embeds: new Map([['deepseek', { embed: { sendTaskObservation() { pageCalls++; return 'ok' } } }]]) })
  const controller = new AbortController(), owner = { platformId: 'deepseek' }
  assert.equal(await subject.send('saved result', owner, controller.signal, [{}]), 'failed'); assert.equal(pageCalls, 0)
  current = false; assert.equal(await subject.send('saved result', owner, controller.signal, [{}]), 'stale')
})
