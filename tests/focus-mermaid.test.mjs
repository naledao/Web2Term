// User-run only: node --test tests/focus-mermaid.test.mjs tests/focus-code.test.mjs tests/focus-math.test.mjs
// Render orchestration and real Mermaid parsing with fake DOM/layout; no Electron, browser, user session or network.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { Script } from 'node:vm'
import ts from 'typescript'

const source = readFileSync(new URL('../src/renderer/src/focus-mermaid.ts', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText
const plain = value => JSON.parse(JSON.stringify(value))
const tick = async () => { for (let i = 0; i < 12; i++) await Promise.resolve() }

function fixture(render = async () => ({ svg: '<svg xmlns="http://www.w3.org/2000/svg"><text>图表</text></svg>' }), vertices = new Map(), mermaid) {
  const configurations = [], renders = [], containers = []
  let imports = 0
  const exports = {}
  new Script(compiled).runInNewContext({
    exports, Error,
    document: {
      createElement(tag) {
        assert.equal(tag, 'div')
        const element = { style: {}, attributes: {}, removed: false,
          setAttribute(name, value) { this.attributes[name] = value },
          remove() { this.removed = true } }
        return element
      },
      body: { appendChild(element) { containers.push(element) } }
    },
    require(name) {
      assert.equal(name, 'mermaid')
      imports++
      return { default: {
        initialize(config) { configurations.push(plain(config)); mermaid?.initialize(config) },
        async parse(text) { return mermaid ? mermaid.parse(text) : { diagramType: 'flowchart-v2' } },
        mermaidAPI: { async getDiagramFromText(text) {
          return mermaid ? mermaid.mermaidAPI.getDiagramFromText(text) : { db: { getVertices: () => vertices } }
        } },
        render(id, text, container) { renders.push({ id, text, container }); return render(id, text, container) }
      } }
    }
  })
  return { ...exports, configurations, renders, containers, imports: () => imports }
}

test('rendering uses the requested theme, protected strict configuration and a disposable measurement node', async () => {
  const f = fixture()
  const svg = await f.renderFocusMermaid('flowchart TD\n A["中文"] --> B', 'dark', () => false)
  assert.match(svg, /<svg/)
  const config = f.configurations[0]
  assert.equal(config.theme, 'dark')
  assert.equal(config.securityLevel, 'strict')
  assert.equal(config.startOnLoad, false)
  assert.equal(config.htmlLabels, false)
  assert.equal(config.suppressErrorRendering, true)
  for (const key of ['securityLevel', 'htmlLabels', 'dompurifyConfig', 'maxTextSize', 'maxEdges']) assert.ok(config.secure.includes(key))
  assert.equal(f.containers[0].attributes['aria-hidden'], 'true')
  assert.match(f.containers[0].style.cssText, /visibility:hidden/)
  assert.equal(f.containers[0].removed, true)
  assert.equal(f.renders[0].text, 'flowchart TD\n A["中文"] --> B')
})

test('real Mermaid preflight applies frontmatter and init config and resets it for the next diagram', async t => {
  const { default: mermaid } = await import('mermaid')
  const { default: DOMPurify } = await import('dompurify')
  // Node has no DOM. Only replace label sanitization for these trusted branch names;
  // Mermaid's actual preprocessing, config protection and gitGraph parser still run.
  const sanitize = Object.getOwnPropertyDescriptor(DOMPurify, 'sanitize')
  DOMPurify.sanitize = text => String(text)
  t.after(() => {
    if (sanitize) Object.defineProperty(DOMPurify, 'sanitize', sanitize)
    else delete DOMPurify.sanitize
    mermaid.mermaidAPI.globalReset()
  })
  mermaid.mermaidAPI.globalReset()
  const cases = [
    { branch: 'master', source: '---\nconfig:\n  gitGraph:\n    mainBranchName: master\n  securityLevel: loose\n  htmlLabels: true\n  maxEdges: 10000\n---\ngitGraph\n  commit\n  checkout master\n  commit' },
    { branch: 'trunk', source: '%%{init: {"gitGraph": {"mainBranchName": "trunk"}}}%%\ngitGraph\n  commit\n  checkout trunk\n  commit' },
    { branch: 'main', source: 'gitGraph\n  commit\n  checkout main\n  commit' }
  ]
  const f = fixture(async (_id, text) => {
    const expected = cases[f.renders.length - 1]
    assert.equal(text, expected.source)
    const config = mermaid.mermaidAPI.getConfig()
    assert.equal(config.gitGraph.mainBranchName, expected.branch)
    assert.equal(config.securityLevel, 'strict')
    assert.equal(config.htmlLabels, false)
    assert.equal(config.maxEdges, 500)
    return { svg: '<svg />' }
  }, undefined, mermaid)
  for (const { source } of cases) {
    assert.equal(await f.renderFocusMermaid(source, 'light', () => false), '<svg />')
  }
  assert.equal(f.renders.length, cases.length)
  assert.ok(f.containers.every(container => container.removed))
})

test('concurrent diagrams serialize their configuration and use distinct SVG ids', async () => {
  let finish
  const f = fixture(() => f.renders.length === 1 ? new Promise(resolve => { finish = resolve }) : Promise.resolve({ svg: '<svg />' }))
  const first = f.renderFocusMermaid('graph TD; A-->B', 'dark', () => false)
  const second = f.renderFocusMermaid('sequenceDiagram\n A->>B: hello', 'light', () => false)
  await tick()
  assert.equal(f.configurations.length, 1)
  finish({ svg: '<svg />' })
  await Promise.all([first, second])
  assert.deepEqual(f.configurations.map(config => config.theme), ['dark', 'default'])
  assert.notEqual(f.renders[0].id, f.renders[1].id)
  assert.ok(f.containers.every(container => container.removed))
})

test('obsolete streamed diagrams are skipped and in-progress stale output is discarded', async () => {
  let finish, cancelled = false
  const f = fixture(() => new Promise(resolve => { finish = resolve }))
  assert.equal(await f.renderFocusMermaid('obsolete source', 'light', () => true), null)
  assert.equal(f.imports(), 0)
  const result = f.renderFocusMermaid('graph TD; A-->B', 'light', () => cancelled)
  await tick()
  cancelled = true
  finish({ svg: '<svg />' })
  assert.equal(await result, null)
  assert.equal(f.containers[0].removed, true)
})

test('malformed and oversized diagrams do not leave temporary DOM or block the next render', async () => {
  const f = fixture(async () => {
    if (f.renders.length === 1) throw new Error('unfinished syntax')
    return { svg: '<svg />' }
  })
  await assert.rejects(f.renderFocusMermaid('flowchart TD\n A[', 'light', () => false), /unfinished syntax/)
  assert.equal(f.containers[0].removed, true)
  await assert.rejects(f.renderFocusMermaid('a'.repeat(f.MAX_MERMAID_TEXT_SIZE + 1), 'light', () => false), /内容过长/)
  assert.equal(await f.renderFocusMermaid('graph TD; A-->B', 'light', () => false), '<svg />')
  assert.equal(f.renders.length, 2)
  assert.ok(f.containers.every(container => container.removed))
})

test('parsed image nodes fall back to source before any DOM layout or image decoding', async () => {
  const vertices = new Map([['A', { img: 'https://example.invalid/image.png' }]])
  const f = fixture(undefined, vertices)
  await assert.rejects(f.renderFocusMermaid('flowchart TD; A@{ "img": "https://example.invalid/image.png" }', 'light', () => false), /含图片节点/)
  assert.equal(f.renders.length, 0)
  assert.equal(f.containers.length, 0)
  vertices.clear()
  assert.match(await f.renderFocusMermaid('flowchart TD; A["文档 https://example.invalid"] --> B', 'light', () => false), /<svg/)
  assert.equal(f.renders.length, 1, 'the unsupported graph does not block later text diagrams')
})
