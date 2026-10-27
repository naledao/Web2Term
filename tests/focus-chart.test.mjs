// User-run only: node --test tests/focus-chart.test.mjs
// Render the real component offline; no Electron or network.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { Script } from 'node:vm'
import { test } from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import ts from 'typescript'

const exports = {}
new Script(ts.transpileModule(readFileSync(new URL('../src/renderer/src/components/FocusChart.tsx', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX }
}).outputText).runInNewContext({ exports, require: createRequire(import.meta.url) })
const { default: FocusChart, parseFocusChart } = exports
const chart = { kind: 'bar', title: '跨实验板已知药物条件评价', caption: '原尺度 MSE，越低越好；并非 drug-blind 测试。',
  series: [{ name: 'MSE', unit: '' }], rows: [{ label: '零差分', values: [.9684] }, { label: '同药同条件跨板均值', values: [1.7572] }] }
const render = data => renderToStaticMarkup(React.createElement(FocusChart, { data }))

test('categorical bars stay bars with a title, caption and exact values', () => {
  const html = render(parseFocusChart(JSON.stringify(chart)))
  assert.equal((html.match(/class="focus-chart__bar"/g) ?? []).length, 2)
  assert.doesNotMatch(html, /<polyline|<circle/)
  assert.match(html, /跨实验板已知药物条件评价/)
  assert.match(html, /drug-blind/)
  assert.match(html, /零差分 · MSE: 0\.9684/)
  assert.match(html, /同药同条件跨板均值 · MSE: 1\.7572/)
  assert.match(html, /查看数据/)
})

test('known lines keep lines; old and unsupported charts keep data without an invented trend', () => {
  assert.match(render({ ...chart, kind: 'line' }), /<polyline/)
  const { kind, ...legacy } = chart
  const parsed = parseFocusChart(JSON.stringify(legacy))
  assert.equal(parsed.kind, 'table')
  const html = render(parsed)
  assert.match(html, /<table/)
  assert.match(html, /1\.7572/)
  assert.doesNotMatch(html, /<svg|<polyline/)
  assert.equal(parseFocusChart(JSON.stringify({ ...chart, kind: 'pie' })), null)
})

test('negative, zero and single-category bars have finite geometry and a zero baseline', () => {
  for (const values of [[-2, -1], [-2, 1], [0, 0], [3]]) {
    const data = parseFocusChart(JSON.stringify({ ...chart, rows: values.map((value, index) => ({ label: String(index), values: [value] })) }))
    assert.ok(data)
    const html = render(data)
    assert.doesNotMatch(html, /NaN|Infinity/)
    assert.equal((html.match(/class="focus-chart__bar"/g) ?? []).length, values.length)
    assert.match(html, /text-anchor="end">0</)
    for (const match of html.matchAll(/<rect[^>]*height="([^"]+)"/g)) assert.ok(Number(match[1]) >= 0)
  }
})

test('long categories and many bars remain available without losing their data', () => {
  const label = '同药同细胞同浓度同处理时间跨实验板独立重复条件下的完整类别名称'
  const data = { ...chart, rows: Array.from({ length: 20 }, (_, index) => ({ label: label + index, values: [index / 10] })) }
  const html = render(data)
  assert.match(html, /min-width:/)
  assert.ok(html.includes(`<title>${label}19</title>`))
  assert.equal((html.match(/class="focus-chart__bar"/g) ?? []).length, 20)
  assert.doesNotMatch(html, /NaN|Infinity/)
})
