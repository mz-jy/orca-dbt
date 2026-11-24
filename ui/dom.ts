// Small DOM helpers the page's views share.
import type { ChangeKind } from '../src/protocol'

export const SVG_NS = 'http://www.w3.org/2000/svg'

/** How the page labels what a branch did to a node, in the graph, the lists and the model. */
export const CHANGE_LETTERS: Record<ChangeKind, string> = { added: 'A', modified: 'M', yaml: 'Y', macro: 'ƒ' }
export const CHANGE_LABELS: Record<ChangeKind, string> = {
  added: 'new file',
  modified: 'SQL changed',
  yaml: 'YAML changed',
  macro: 'a macro it uses changed'
}

/** A small A/M/Y/ƒ tag, styled by kind. */
export function changeTag(change: ChangeKind): HTMLSpanElement {
  return el('span', { class: `change-tag changed-${change}`, title: CHANGE_LABELS[change] }, CHANGE_LETTERS[change])
}

const TYPE_COLORS: Record<string, string> = {
  model: '#3b82f6',
  source: '#10b981',
  seed: '#a855f7',
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

export function byId<T extends Element>(id: string): T {
  return document.getElementById(id) as unknown as T
}

type Attributes = { class?: string; title?: string; type?: string; hidden?: boolean; disabled?: boolean } & Record<
  `data-${string}`,
  string
>

type Child = Node | string | null | false

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

/** Replaces `parent`'s content; null and false stand for content left out. */
export function fill(parent: Element, ...children: Child[]): void {
  parent.replaceChildren(...children.filter((child): child is Node | string => child !== null && child !== false))
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

/** A small square in the type's colour. */
export function swatch(type: string): HTMLSpanElement {
  const element = el('span', { class: 'swatch', title: type })
  element.style.background = typeColor(type)
  return element
}

export function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}
