import type { DeepSeekContextSnapshot } from './deepseek-question'
import { DeepSeekQuestionError } from './deepseek-question'

const escape = (text: string): string => text.replace(/[&<>"']/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[char]!))

/** A self-contained text document: no site scripts, external assets or credentials. */
export function deepSeekContextHtml(snapshot: DeepSeekContextSnapshot): string {
  if (!/^https:\/\/chat\.deepseek\.com\/share\/[\w-]{1,128}$/.test(snapshot.shareUrl)) throw new DeepSeekQuestionError('html-source', '本地 HTML 的来源链接无效。')
  const messages = snapshot.messages.map((message, index) => `<article aria-labelledby="message-${index}">
<h2 id="message-${index}">${index + 1}. ${message.role === 'user' ? '用户' : 'DeepSeek'} <span>消息 ${message.id}</span></h2>
${message.text ? `<pre>${escape(message.text)}</pre>` : '<p class="meta">此消息没有文字正文。</p>'}
</article>`).join('\n')
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
<title>${escape(snapshot.title)} — DeepSeek 对话文字快照</title>
<style>
:root{color-scheme:light dark;--bg:#f5f7fc;--surface:#fff;--text:#24334b;--muted:#596982;--line:#d9e1ee;--accent:#4361d5}
@media(prefers-color-scheme:dark){:root{--bg:#141a25;--surface:#1c2330;--text:#e6edf6;--muted:#a2b0c5;--line:#39465a;--accent:#96adff}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:15px/1.75 system-ui,"Segoe UI","Microsoft YaHei",sans-serif}
main{max-width:980px;margin:0 auto;padding:40px 24px 64px}h1{margin:0 0 12px;font-size:28px;line-height:1.4;overflow-wrap:anywhere}a{color:var(--accent);overflow-wrap:anywhere;text-underline-offset:3px}
.meta{color:var(--muted);font-size:13px}header{padding-bottom:24px;border-bottom:1px solid var(--line)}.selection{margin:24px 0;padding:16px;background:var(--surface);border-radius:8px}
h2{margin:0 0 12px;font-size:16px}h2 span{margin-left:8px;font-size:12px;font-weight:400;color:var(--muted)}blockquote{margin:8px 0 16px;white-space:pre-wrap;overflow-wrap:anywhere}
article{padding:28px 0;border-bottom:1px solid var(--line)}pre{margin:0;white-space:pre-wrap;overflow-wrap:anywhere;tab-size:4;font:inherit}p{margin:8px 0}a:focus-visible{outline:2px solid var(--accent);outline-offset:3px}::selection{background:var(--accent);color:var(--surface)}
@media(max-width:600px){main{padding:24px 16px}h1{font-size:23px}.selection{padding:12px}}
@media print{:root{--bg:#fff;--surface:#fff;--text:#000;--muted:#444;--line:#ccc;--accent:#000}main{max-width:none;padding:0}article{break-inside:auto}}
</style></head><body><main>
<header><h1>${escape(snapshot.title)}</h1><p class="meta">对话文字快照 · ${snapshot.messages.length} 条消息 · 截至所选回答</p>
<p>来源：<a href="${escape(snapshot.shareUrl)}" rel="noreferrer">${escape(snapshot.shareUrl)}</a></p>
<p class="meta">正文已保存在本文件中，离线打开即可阅读。保留原始文字与 Markdown 标记，不包含推理过程、图片或附件文件。</p></header>
<section class="selection" aria-label="本次提问"><h2>选中的内容</h2><blockquote>${escape(snapshot.selectedText)}</blockquote><h2>用户问题</h2><pre>${escape(snapshot.question)}</pre></section>
${messages}
</main></body></html>`
}
