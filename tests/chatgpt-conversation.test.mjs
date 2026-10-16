// User-run offline route regressions; no Electron, browser, shell or network.
// Run: node --test tests/chatgpt-conversation.test.mjs
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { Script } from 'node:vm'
import ts from 'typescript'

function load(relative, dependencies) {
  const exports = {}
  const source = readFileSync(new URL(relative, import.meta.url), 'utf8')
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText
  new Script(compiled).runInNewContext({
    exports, URL,
    require(name) {
      assert.ok(name in dependencies, `unexpected dependency ${name}`)
      return dependencies[name]
    }
  })
  return exports
}
const fileRequests = load('../src/shared/file-requests.ts', {})
const types = load('../src/shared/types.ts', { './file-requests': fileRequests })
const { CHATGPT_PLATFORM } = load('../src/shared/platforms.ts', { './types': types })
const id = '6ad1b11e-bec4-83e8-be6f-24834af50921'

test('ordinary and nested project/GPT conversations resolve to the same stable id', () => {
  for (const path of [`/c/${id}`, `/g/g-p-project-name/c/${id}`, `/g/g-custom-assistant/c/${id}`]) {
    assert.equal(CHATGPT_PLATFORM.conversationIdFromPath(path), id)
    assert.equal(types.conversationIdFromUrl(`https://chatgpt.com${path}?model=example#bottom`), id)
  }
})

test('encoded valid ids are supported and malformed encoding returns null', () => {
  assert.equal(CHATGPT_PLATFORM.conversationIdFromPath(`/g/g-p-project/c/%36${id.slice(1)}`), id)
  assert.equal(CHATGPT_PLATFORM.conversationIdFromPath('/g/g-p-project/c/%E0%A4'), null)
  assert.equal(types.conversationIdFromUrl('https://chatgpt.com/c/%E0%A4'), null)
})

test('project landing pages, unrelated paths and invalid ids do not become conversations', () => {
  for (const path of ['/g/g-p-project', '/g/g-p-project/project', '/g/g-p-project/c/new',
    '/g//c/' + id, '/somewhere/c/' + id, '/c/placeholder', '/']) {
    assert.equal(CHATGPT_PLATFORM.conversationIdFromPath(path), null)
  }
  assert.equal(types.conversationIdFromUrl(`https://example.test/g/g-p-project/c/${id}`), null)
})
