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
    this.nodeType = 1; this.tagName = tag.toUpperCase(); this.localName = tag; this.attrs = { ...attrs }
    this.childNodes = children.map(child => typeof child === 'string' ? { nodeType: 3, nodeValue: child } : child)
    for (const child of this.childNodes) child.parentElement = this
  }
  get children() { return this.childNodes.filter(child => child.nodeType === 1) }
  get textContent() { return this.childNodes.map(child => child.nodeValue ?? child.textContent).join('') }
  set textContent(value) { this.childNodes = [{ nodeType: 3, nodeValue: value, parentElement: this }] }
  get attributes() { return Object.entries(this.attrs).map(([name, value]) => ({ name, value })) }
  get className() { return this.attrs.class || '' }
  getAttribute(name) { return this.attrs[name] ?? null }
  setAttribute(name, value) { this.attrs[name] = value }
  removeAttribute(name) { delete this.attrs[name] }
  getBoundingClientRect() { return { width: 800, height: 600 } }
  cloneNode() { return new Element(this.localName, this.attrs, this.childNodes.map(child => child.nodeType === 3 ? child.nodeValue : child.cloneNode(true))) }
  remove() { if (this.parentElement) this.parentElement.childNodes = this.parentElement.childNodes.filter(child => child !== this) }
  matches(selector) {
    return selector.split(',').some(part => {
      part = part.trim()
      if (part === '*') return true
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
const escapeXml = value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const serialize = node => node.nodeType === 3 ? escapeXml(node.nodeValue) :
  '<' + node.localName + Object.entries(node.attrs).map(([name, value]) => ' ' + name + '="' + escapeXml(value) + '"').join('') + '>' +
  node.childNodes.map(serialize).join('') + '</' + node.localName + '>'
const extractionContext = {
  PAGE: { focus: null }, Node: { TEXT_NODE: 3, ELEMENT_NODE: 1 }, replyRootOf: node => node,
  messageIdOf: () => 'native-message', getComputedStyle: element => ({ backgroundColor: element.attrs['data-background'] || 'rgba(0, 0, 0, 0)' }),
  XMLSerializer: class { serializeToString(element) { return serialize(element) } }
}
extractionContext.nativeMermaidMarkdown = new Script('(' + initializer(source, 'nativeMermaidMarkdown') + ')').runInNewContext(extractionContext)
const extract = new Script('(' + initializer(source, 'readReplyMarkdown') + ')').runInNewContext(extractionContext)
const layoutExports = {}
new Script(ts.transpileModule(readFileSync(new URL('../src/shared/focus-layout.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText).runInNewContext({ exports: layoutExports, URL, require: () => ({}) })
const layoutComponent = {}
new Script(ts.transpileModule(readFileSync(new URL('../src/renderer/src/components/FocusLayout.tsx', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX }
}).outputText).runInNewContext({ exports: layoutComponent, require(name) {
  return name.endsWith('.css') || name.startsWith('@shared/') || name === './FocusMessageLink' ? {} : require(name)
} })
const codeExports = {}
const htmlPreviewExports = {}
new Script(ts.transpileModule(readFileSync(new URL('../src/shared/focus-html-preview.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText).runInNewContext({ exports: htmlPreviewExports })
new Script(ts.transpileModule(readFileSync(new URL('../src/renderer/src/components/FocusCodeBlock.tsx', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX }
}).outputText).runInNewContext({ exports: codeExports, require(name) {
  return name === '@shared/focus-html-preview' ? htmlPreviewExports : require(name)
} })
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

const nativeDiagram = () => el('svg', [
  el('title', ['整体架构']),
  el('style', ['#chatgpt-mermaid-r_ol {font-family:Arial;fill:rgb(13,13,13)} .edge {marker-end:url(https://chatgpt.com/c/original#arrow)}']),
  el('defs', [el('marker', [el('path', [], { d: 'M0 0L5 5L0 10' })], { id: 'arrow' })]),
  el('g', [el('path', [], { d: 'M0 0L100 100', 'marker-end': 'url(https://chatgpt.com/c/original#arrow)' }),
    el('foreignObject', [el('div', ['browser-harness CLI / MCP'], { xmlns: 'http://www.w3.org/1999/xhtml' })], { width: '200', height: '50' }),
    el('text', ['daemon.py'])])
], { id: 'chatgpt-mermaid-r_ol', viewBox: '0 0 900 700', width: '100%', role: 'graphics-document' })
const diagramData = markdown => {
  const match = /<!--focus-layout (\{[^\n]*\}) -->/.exec(markdown)
  assert.ok(match, 'a native diagram is exported using the validated layout transport')
  const data = layoutExports.parseFocusLayout(match[1])
  assert.ok(data, 'the renderer accepts the complete image payload')
  return data
}
const imageSource = data => decodeURIComponent(data.root.children[0].attrs.src.split(',').slice(1).join(','))

test('ChatGPT rendered Mermaid SVGs retain labels, foreignObject layout and arrows without leaking CSS into prose', () => {
  const diagram = nativeDiagram(), original = serialize(diagram)
  const markdown = extract(el('article', [el('h2', ['整体架构']), diagram, el('p', ['下面解释文件关联。'])], { 'data-background': 'rgb(255, 255, 255)' }))
  assert.match(markdown, /^## 整体架构/)
  assert.match(markdown, /> browser-harness CLI \/ MCP\n> daemon\.py/)
  assert.match(markdown, /下面解释文件关联。$/)
  assert.doesNotMatch(markdown, /font-family:|#chatgpt-mermaid-r_ol|marker-end:url/)
  const data = diagramData(markdown), svg = imageSource(data)
  assert.equal(data.sourceMessageId, 'native-message')
  assert.equal(data.width, 900)
  assert.match(svg, /<foreignObject/)
  assert.match(svg, /<marker id="arrow"/)
  assert.match(svg, /marker-end="url\(#arrow\)"/)
  assert.match(svg, /background-color:rgb\(255, 255, 255\)/)
  assert.match(svg, /animation:none!important/)
  assert.equal(serialize(diagram), original, 'export never mutates the original page or diagram')
  const html = renderToStaticMarkup(React.createElement(layoutComponent.default, { data }))
  assert.match(html, /<img[^>]+src="data:image\/svg\+xml/)
  assert.match(html, /alt="整体架构"/)
  assert.doesNotMatch(html, /<svg|<foreignObject|<script|<style/)
})

test('native diagram images drop executable nodes, handlers and external references while preserving local markers', () => {
  const diagram = nativeDiagram()
  diagram.setAttribute('onload', 'unsafeRoot()')
  diagram.childNodes.push(el('script', ['unsafeScript()']), el('animate', [], { attributeName: 'x' }),
    el('image', [], { href: 'https://example.invalid/tracker.png', onerror: 'unsafeImage()' }),
    el('use', [], { 'xlink:href': '#arrow' }), el('use', [], { href: 'https://example.invalid/external.svg#shape' }),
    el('style', ['@import url(https://example.invalid/style.css); .node{fill:url(https://example.invalid/paint.svg)}']))
  const svg = imageSource(diagramData(extract(el('article', [diagram], { 'data-background': 'rgb(20, 20, 20)' }))))
  assert.doesNotMatch(svg, /unsafeRoot|unsafeScript|unsafeImage|onload|onerror|<script|<animate|example\.invalid|@import/)
  assert.match(svg, /xlink:href="#arrow"/)
  assert.match(svg, /fill:none/)
  assert.match(svg, /background-color:rgb\(20, 20, 20\)/)
})

test('diagram fallbacks preserve readable labels and surrounding prose when an image exceeds the existing transport', () => {
  const diagram = nativeDiagram()
  diagram.childNodes.push(el('path', [], { d: 'M0 0L1 1'.repeat(20_000) }))
  const markdown = extract(el('article', [el('p', ['之前的说明']), diagram, el('p', ['之后的说明'])]))
  assert.doesNotMatch(markdown, /<!--focus-layout|font-family:|M0 0L1 1/)
  assert.match(markdown, /之前的说明/)
  assert.match(markdown, /browser-harness CLI \/ MCP/)
  assert.match(markdown, /图表较大，请切回原始页面查看完整图表/)
  assert.match(markdown, /之后的说明/)
})

test('ordinary SVG icons and page styles are excluded while SVG code samples remain intact', () => {
  const sample = '<svg><style>.node{fill:red}</style><text>源码</text></svg>'
  const markdown = extract(el('article', [el('style', ['.page{color:red}']), el('script', ['unsafe()']),
    el('svg', [el('style', ['.icon{fill:red}']), el('text', ['toolbar icon'])]),
    el('pre', [el('code', [sample], { class: 'language-xml' })]), el('p', ['有效正文'])]))
  assert.doesNotMatch(markdown, /\.page|\.icon|toolbar icon|unsafe/)
  assert.ok(markdown.includes('```xml\n' + sample + '\n```'))
  assert.match(markdown, /有效正文$/)
})

test('copying the Prism token tree produces only original code and preserves whitespace', () => {
  const tokens = React.createElement('code', null, React.createElement('span', { className: 'token keyword' }, 'public'), ' class A {\n\n\n  ',
    React.createElement('span', { className: 'token string' }, '"<b>"'), '\n}')
  assert.equal(codeExports.codeBlockText(tokens), 'public class A {\n\n\n  "<b>"\n}')
})

test('HTML preview is available in shared code cards without platform metadata and never auto-runs', () => {
  for (const markdown of ['```html\n<button onclick="this.textContent=123">运行</button>\n```',
    '```\n<!DOCTYPE html><html><body>完整网页</body></html>\n```', '```text\n<div>HTML 片段</div>\n```']) {
    const html = render(markdown)
    assert.match(html, /aria-label="运行 HTML 预览"/)
    assert.match(html, /运行预览/)
    assert.doesNotMatch(html, /<iframe|<script|<button onclick=/)
  }
  for (const [language, text] of [['javascript', 'const html = "<div>示例</div>"'], ['jsx', '<div>组件</div>'],
    ['xml', '<svg></svg>'], ['css', 'body { color: red }'], ['html', '']]) {
    assert.doesNotMatch(render('```' + language + '\n' + text + '\n```'), /运行 HTML 预览/)
  }
})
