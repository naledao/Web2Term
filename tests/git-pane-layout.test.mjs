// User-run offline regression: node --test tests/git-pane-layout.test.mjs
// No Electron startup, UI automation or network access.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { Script } from 'node:vm'
import ts from 'typescript'

const exports = {}
const source = readFileSync(new URL('../src/renderer/src/git-pane-layout.ts', import.meta.url), 'utf8')
new Script(ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText).runInNewContext({ exports })
const { clampGitPaneWidth, gitPaneBounds, GIT_DIVIDER_WIDTH, GIT_DIFF_MIN_WIDTH } = exports

test('wide windows allow enough space for long paths beyond the former 620px cap', () => {
  assert.equal(clampGitPaneWidth(900, 1920), 900)
  const largest = clampGitPaneWidth(5000, 1920)
  assert.equal(1920 - largest - GIT_DIVIDER_WIDTH, GIT_DIFF_MIN_WIDTH)
})

test('a width saved on a larger display fits a smaller container and keeps the diff readable', () => {
  const restored = clampGitPaneWidth(1100, 900)
  assert.ok(restored < 1100)
  assert.equal(900 - restored - GIT_DIVIDER_WIDTH, GIT_DIFF_MIN_WIDTH)
  assert.equal(clampGitPaneWidth(-100, 900), 260)
})

test('small or temporarily hidden containers never produce negative widths or overflow', () => {
  for (const width of [0, 8, 240, 480, 640, 1280, NaN, Infinity]) {
    const bounds = gitPaneBounds(width)
    assert.ok(Number.isFinite(bounds.min) && Number.isFinite(bounds.max))
    assert.ok(bounds.min >= 0 && bounds.max >= bounds.min)
    const pane = clampGitPaneWidth(900, width)
    assert.ok(Number.isFinite(pane) && pane >= 0)
    if (Number.isFinite(width) && width >= GIT_DIVIDER_WIDTH) {
      assert.ok(pane + GIT_DIVIDER_WIDTH <= width)
    }
  }
  assert.equal(clampGitPaneWidth(NaN, 1280), 360)
})
