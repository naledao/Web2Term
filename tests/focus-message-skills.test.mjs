// User-run only: node --test tests/focus-message-skills.test.mjs
// Actual read-only message badges and vector icons rendered without Electron or network.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { Script } from 'node:vm'
import test from 'node:test'
import { createElement } from 'react'
import * as jsxRuntime from 'react/jsx-runtime'
import { renderToStaticMarkup } from 'react-dom/server'
import ts from 'typescript'

function load(path, dependencies = {}) {
  const exports = {}
  new Script(ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX }
  }).outputText).runInNewContext({ exports, require(name) {
    assert.ok(Object.hasOwn(dependencies, name), 'Unexpected dependency: ' + name)
    return dependencies[name]
  } })
  return exports
}
const shared = load('../src/shared/focus-skills.ts')
const icons = load('../src/renderer/src/components/FocusSkillIcon.tsx', { 'react/jsx-runtime': jsxRuntime })
const { default: Badges } = load('../src/renderer/src/components/FocusMessageSkills.tsx', {
  'react/jsx-runtime': jsxRuntime, '@shared/focus-skills': shared, './FocusSkillIcon': icons
})
const render = skills => renderToStaticMarkup(createElement(Badges, { skills }))

test('each selected skill shows its own icon and name in selection order, without draft controls', () => {
  const html = render(['computer', 'scheduled_task', 'send_email'])
  assert.match(html, /aria-label="引用的技能"/)
  assert.equal((html.match(/<li>/g) ?? []).length, 3)
  const vectors = html.match(/<svg\b[\s\S]*?<\/svg>/g) ?? []
  assert.equal(vectors.length, 3)
  assert.equal(new Set(vectors).size, 3, 'skill silhouettes are distinct')
  assert.ok(vectors.every(vector => vector.includes('aria-hidden="true"')))
  assert.ok(html.indexOf('电脑操作') < html.indexOf('定时任务') && html.indexOf('定时任务') < html.indexOf('邮件通知'))
  assert.doesNotMatch(html, /<button|role="switch"|设置|移除/)
})

test('ordinary messages, old history and invalid metadata render no skill placeholder', () => {
  for (const skills of [undefined, null, [], ['invented'], ['computer', 'computer'], ['compact'], 'computer']) {
    assert.equal(render(skills), '')
  }
})
