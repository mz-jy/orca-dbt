// Small DOM helpers and the visual vocabulary the page's views share: how a resource type, a
// branch change and a test result look wherever they appear.
import type { ChangeKind, QualityFlag, TestStatus } from '../src/protocol'
import { icon, type IconName } from './icons'

export const SVG_NS = 'http://www.w3.org/2000/svg'

/** How the page labels what a branch did to a node, in the graph, the lists and the model. */
export const CHANGE_LETTERS: Record<ChangeKind, string> = { added: 'A', modified: 'M', yaml: 'Y', macro: 'ƒ' }
export const CHANGE_LABELS: Record<ChangeKind, string> = {
  added: 'new file',
  modified: 'SQL changed',
  yaml: 'YAML changed',
  macro: 'a macro it uses changed'
}

/** A small A/M/Y/ƒ tag in the change colour. */
export function changeTag(change: ChangeKind): HTMLSpanElement {
  return el('span', { class: `change-tag changed-${change}`, title: `Changed in this branch: ${CHANGE_LABELS[change]}` }, CHANGE_LETTERS[change])
}

export const STATUS_ICONS: Record<TestStatus, string> = { error: '!', fail: '✕', warn: '!', skipped: '–', pass: '✓' }
export const STATUS_LABELS: Record<TestStatus, string> = {
  error: 'error',
  fail: 'failing',
  warn: 'warning',
  skipped: 'skipped',
  pass: 'passing'
}

export function isProblem(status: TestStatus | null): boolean {
  return status === 'error' || status === 'fail' || status === 'warn'
}

/** A test's status as a small round mark; null for a test that never ran. */
export function statusTag(status: TestStatus | null, title = status ? STATUS_LABELS[status] : 'never run'): HTMLSpanElement {
  return el('span', { class: `test-status status-${status ?? 'never'}`, title }, status ? STATUS_ICONS[status] : '')
}

/** "Tests: 2 of 5 with problems (failing)", for tooltips on flagged nodes. */
export function flagTitle(flag: QualityFlag): string {
  return flag.problems > 0
    ? `Tests: ${flag.problems} of ${flag.tests} with problems (worst: ${STATUS_LABELS[flag.status]})`
    : `Tests: ${flag.tests} ${flag.status === 'skipped' ? 'ran, some skipped' : 'passing'}`
}

/** Each resource type's hue; the stylesheet mixes it toward the theme so it reads in light and dark. */
const TYPE_COLORS: Record<string, string> = {
  model: '#3b82f6',
  source: '#10b981',
  seed: '#8b5cf6',
  snapshot: '#f59e0b',
  exposure: '#ef4444',
  metric: '#06b6d4',
  semantic_model: '#14b8a6',
  saved_query: '#64748b',
  analysis: '#84cc16'
}

/** The colour a resource type is drawn in, in the graph and beside every list entry. */
export function typeColor(type: string): string {
  return TYPE_COLORS[type] ?? '#94a3b8'
}

/** "semantic_model" → "semantic model". */
export function typeLabel(type: string): string {
  return type.replace(/_/g, ' ')
}

export function byId<T extends Element>(id: string): T {
  return document.getElementById(id) as unknown as T
}

type Attributes = {
  class?: string
  title?: string
  type?: string
  hidden?: boolean
  disabled?: boolean
  role?: string
  tabindex?: string
} & Record<`data-${string}` | `aria-${string}`, string>

type Child = Node | string | null | false | undefined

/** An HTML element with attributes and children (strings become text, never HTML). */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attributes: Attributes = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag)
  for (const [name, value] of Object.entries(attributes)) {
    if (value === false || value === undefined) continue
    if (name === 'class') element.className = String(value)
    else element.setAttribute(name, value === true ? '' : String(value))
  }
  fill(element, ...children)
  return element
}

/** Replaces `parent`'s content; null, undefined and false stand for content left out. */
export function fill(parent: Element, ...children: Child[]): void {
  parent.replaceChildren(...children.filter((child): child is Node | string => child !== null && child !== false && child !== undefined))
}

export function svgEl<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attributes: Record<string, string | number>,
  parent: Element
): SVGElementTagNameMap[K] {
  const element = document.createElementNS(SVG_NS, tag)
  for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, String(value))
  parent.append(element)
  return element
}

/** A small dot in the type's colour. */
export function swatch(type: string): HTMLSpanElement {
  const element = el('span', { class: 'swatch', title: typeLabel(type) })
  element.style.setProperty('--type', typeColor(type))
  return element
}

export type ButtonOptions = {
  /** `primary` is the one main action of an area; `ghost` sits in toolbars and rows. */
  variant?: 'primary' | 'ghost' | 'danger' | 'default'
  icon?: IconName
  title?: string
  disabled?: boolean
  /** Small, for rows and inline actions. */
  small?: boolean
  class?: string
}

/** A button; with an icon and an empty label it is an icon button (give it a title). */
export function button(label: string, onClick: (event: MouseEvent) => void, options: ButtonOptions = {}): HTMLButtonElement {
  const classes = ['btn', `btn-${options.variant ?? 'default'}`, options.small ? 'btn-sm' : '', label ? '' : 'btn-icon', options.class ?? '']
  const element = el(
    'button',
    { type: 'button', class: classes.filter(Boolean).join(' '), title: options.title, disabled: options.disabled },
    options.icon ? icon(options.icon, options.small ? 13 : 14) : null,
    label ? el('span', {}, label) : null
  )
  if (!label && options.title) element.setAttribute('aria-label', options.title)
  element.addEventListener('click', onClick)
  return element
}

/** The empty or problem state of an area: an icon, a line of text, and an action. */
export function emptyState(iconName: IconName, title: string, text?: string, action?: HTMLElement | null, tone: 'muted' | 'warning' = 'muted'): HTMLElement {
  return el(
    'div',
    { class: `empty-state ${tone}` },
    el('div', { class: 'empty-icon' }, icon(iconName, 18)),
    el('p', { class: 'empty-title' }, title),
    text ? el('p', { class: 'empty-text' }, text) : null,
    action ?? null
  )
}

/** A heading inside a pane: a title, a count, and actions at the right. */
export function sectionHead(title: string, count?: number | string | null, ...actions: Child[]): HTMLElement {
  return el(
    'div',
    { class: 'section-head' },
    el('h3', {}, title),
    count !== undefined && count !== null ? el('span', { class: 'count-badge' }, String(count)) : null,
    el('span', { class: 'spacer' }),
    ...actions
  )
}

/** Copies `text`, and says so on `trigger` for a moment. */
export function copyButton(text: string, title = 'Copy'): HTMLButtonElement {
  const element = button('', () => {
    void navigator.clipboard
      ?.writeText(text)
      .then(() => {
        element.classList.add('copied')
        element.replaceChildren(icon('check', 13))
        setTimeout(() => {
          element.classList.remove('copied')
          element.replaceChildren(icon('copy', 13))
        }, 1200)
      })
      .catch(() => {})
  }, { variant: 'ghost', icon: 'copy', small: true, title })
  return element
}

export function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

export function plural(count: number, one: string, many = `${one}s`): string {
  return `${count.toLocaleString()} ${count === 1 ? one : many}`
}
