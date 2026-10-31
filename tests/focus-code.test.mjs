// User-run only: node --test tests/focus-code.test.mjs tests/focus-math.test.mjs
// Actual extraction, bundled Prism and React code cards with synthetic HTML; no Electron or network.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { Script } from 'node:vm'
import { test } from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { fromHtmlIsomorphic } from 'hast-util-from-html-isomorphic'
import ts from 'typescript'

const require = createRequire(import.meta.url)
const previewRequire = createRequire(require.resolve('@uiw/react-markdown-preview'))
const { default: ReactMarkdown } = await import(previewRequire.resolve('react-markdown'))
const { default: prism } = await import(previewRequire.resolve('rehype-prism-plus'))
const source = ts.createSourceFile('page.js', readFileSync(new URL('../src/main/injected/send-interceptor.js', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
function initializer(node, name) {
  if (ts.isVariableDeclaration(node) && node.name.getText(source) === name) return node.initializer.getText(source)
  return ts.forEachChild(node, child => initializer(child, name))
}

class Element {
  constructor(tag, attrs = {}, children = []) {
    this.nodeType = 1; this.tagName = tag.toUpperCase(); this.attrs = attrs
    this.childNodes = children.map(child => typeof child === 'string' ? { nodeType: 3, nodeValue: child } : child)
    for (const child of this.childNodes) child.parentElement = this
  }
  get children() { return this.childNodes.filter(child => child.nodeType === 1) }
  get textContent() { return this.childNodes.map(child => child.nodeValue ?? child.textContent).join('') }
  get className() { return this.attrs.class || '' }
  getAttribute(name) { return this.attrs[name] ?? null }
  matches(selector) {
    return selector.split(',').some(part => {
      part = part.trim()
      if (part.startsWith('.')) return this.className.split(' ').includes(part.slice(1))
      const attribute = /^(\w+)?\[([\w-]+)="([^"]+)"\]$/.exec(part)
      if (attribute) return (!attribute[1] || this.matches(attribute[1])) && this.getAttribute(attribute[2]) === attribute[3]
      return this.tagName.toLowerCase() === part
    })
  }
  querySelectorAll(selector) { return this.children.flatMap(child => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]) }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null }
}
const el = (tag, children, attrs = {}) => new Element(tag, attrs, children)
function parse(html) {
  const convert = node => node.type === 'text' ? node.value : new Element(node.tagName,
    Object.fromEntries(Object.entries(node.properties).map(([key, value]) => [key === 'className' ? 'class' : key, Array.isArray(value) ? value.join(' ') : String(value)])),
    node.children.filter(child => child.type === 'element' || child.type === 'text').map(convert))
  const tree = fromHtmlIsomorphic(html, { fragment: true })
  return new Element('article', {}, tree.children.map(convert))
}
const extract = new Script('(' + initializer(source, 'readReplyMarkdown') + ')').runInNewContext({
  PAGE: { focus: null }, Node: { TEXT_NODE: 3, ELEMENT_NODE: 1 }, replyRootOf: node => node
})
const codeExports = {}
new Script(ts.transpileModule(readFileSync(new URL('../src/renderer/src/components/FocusCodeBlock.tsx', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX }
}).outputText).runInNewContext({ exports: codeExports, require })
const render = markdown => renderToStaticMarkup(React.createElement(ReactMarkdown, {
  skipHtml: true, rehypePlugins: [[prism, { ignoreMissing: true }]], components: { pre: codeExports.default }
}, markdown))
const java = 'public class MyJob implements Job {\n    @Override\n    public void execute(JobExecutionContext context) {\n        System.out.println("执行定时任务");\n    }\n}'
const header = language => el('div', [el('span', [language]), el('button', ['复制代码']), el('button', ['自动换行'])])

test('a toolbar language label becomes the fence language and is not duplicated in prose or copied code', () => {
  const markdown = extract(el('article', [el('p', ['定义任务：']), el('div', [header('Java'), el('pre', [el('code', [java])])]), el('p', ['继续配置触发器。'])]))
  assert.match(markdown, /```java\npublic class MyJob/)
  assert.doesNotMatch(markdown, /Java|复制代码|自动换行/)
  assert.match(markdown, /定义任务：/); assert.match(markdown, /继续配置触发器。/)
  const html = render(markdown)
  assert.match(html, /focus-code-block__language">Java</)
  assert.match(html, /class="token keyword"/)
  assert.match(html, /aria-label="复制代码"/)
  assert.match(html, /aria-label="代码自动换行"/)
})

test('language classes, data attributes and aliases are retained, with safe plain rendering for unknown languages', () => {
  for (const [attribute, value, language] of [['class', 'language-Java', 'java'], ['data-language', 'C++', 'cpp'],
    ['data-lang', 'C#', 'csharp'], ['class', 'lang-py', 'python'], ['data-language', 'my-custom-language', 'my-custom-language']]) {
    const markdown = extract(el('pre', [el('code', ['value'], { [attribute]: value })]))
    assert.ok(markdown.startsWith('```' + language + '\n'), markdown)
    assert.match(render(markdown), /focus-code-block/)
  }
  assert.ok(extract(el('pre', [el('code', [java])], { class: 'language-java' })).startsWith('```java'))
})

test('consecutive blank lines, trailing spaces and literal backtick fences survive extraction', () => {
  const code = 'first  \n\n\n\n```java\n  nested\n```\nlast'
  const markdown = extract(el('pre', [el('code', [code], { class: 'language-text' })]))
  assert.equal(markdown, '````text\n' + code + '\n````')
  const html = render(markdown)
  assert.match(html, /first  \n\n\n\n```java/)
  assert.match(html, /纯文本/)
})

test('nested code keeps Markdown list indentation and ordinary language prose is not removed', () => {
  const markdown = extract(el('article', [el('p', ['Java']), el('ul', [el('li', [el('p', ['示例']), el('pre', [el('code', [java], { class: 'language-java' })])])])]))
  assert.match(markdown, /^Java\n/)
  const html = render(markdown)
  assert.match(html, /<li>/); assert.match(html, /<p>Java<\/p>/)
  assert.match(html, /class="token keyword"/)
})

test('two cards retain independent languages and code with HTML stays escaped text', () => {
  const markdown = extract(parse('<div><div><span>Java</span><button>复制</button></div><pre><code>public class A {}</code></pre></div>' +
    '<p>第二段：</p><div><div><span>HTML</span><button>复制</button></div><pre><code>&lt;script&gt;alert(1)&lt;/script&gt;</code></pre></div>'))
  assert.match(markdown, /```java/); assert.match(markdown, /```html/)
  const html = render(markdown)
  assert.equal((html.match(/class="focus-code-block"/g) || []).length, 2)
  assert.doesNotMatch(html, /<script>/)
  assert.match(html, /&lt;/)
})

test('Mermaid toolbar labels survive extraction and select diagram rendering with intact source', () => {
  const diagram = 'flowchart TD\n  A["输入分层网络"] --> B["Barycenter 初始布局"]\n  B --> C{"是否改善或持平？"}\n  C -->|是| D["接受新布局"]'
  const markdown = extract(el('article', [el('p', ['整体结构：']), el('div', [header('Mermaid'), el('pre', [el('code', [diagram])])])]))
  assert.match(markdown, /```mermaid\nflowchart TD/)
  assert.doesNotMatch(markdown, /Mermaid|复制代码|自动换行/)
  assert.ok(markdown.includes(diagram))
  const html = render(markdown)
  assert.match(html, /focus-code-block__language">Mermaid</)
  assert.match(html, /aria-pressed="true">图表</)
  assert.match(html, /aria-pressed="false">源码</)
  assert.match(html, /正在生成图表/)
  assert.match(html, /输入分层网络/)
  assert.equal(codeExports.codeBlockText(React.createElement('code', null, diagram)), diagram)
  assert.doesNotMatch(render('```text\n' + diagram + '\n```'), /focus-mermaid|>图表</)
})

test('copying the Prism token tree produces only original code and preserves whitespace', () => {
  const tokens = React.createElement('code', null, React.createElement('span', { className: 'token keyword' }, 'public'), ' class A {\n\n\n  ',
    React.createElement('span', { className: 'token string' }, '"<b>"'), '\n}')
  assert.equal(codeExports.codeBlockText(tokens), 'public class A {\n\n\n  "<b>"\n}')
})
