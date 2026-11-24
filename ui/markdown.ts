// dbt descriptions are Markdown. Rendered with marked (vendored: frames have no network); raw
// HTML inside them is shown as text, never parsed, and links open through Orca (see app.ts).
import { Marked } from '../vendor/marked.esm.js'

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => ESCAPES[char])
}

const markdown = new Marked({ gfm: true, renderer: { html: ({ text }) => escapeHtml(text) } })

export function renderMarkdown(source: string): string {
  return markdown.parse(source, { async: false })
}
