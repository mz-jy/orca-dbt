// A small stroke icon set (24×24, drawn at 1.75px), inline SVG: plugin frames have no network.
const SVG_NS = 'http://www.w3.org/2000/svg'

const PATHS = {
  search: 'M11 4a7 7 0 1 0 0 14a7 7 0 0 0 0-14z M20 20l-4-4',
  branch: 'M6 3v12 M18 9a3 3 0 1 0 0-6a3 3 0 0 0 0 6z M6 21a3 3 0 1 0 0-6a3 3 0 0 0 0 6z M18 9a9 9 0 0 1-9 9',
  catalog: 'M4 6h16 M4 12h10 M4 18h7',
  changes: 'M12 3v18 M5 8h6 M8 5v6 M13 16h6',
  quality: 'M9 3h6 M10 3v6l-5 9a2 2 0 0 0 2 3h10a2 2 0 0 0 2-3l-5-9V3 M7.5 14h9',
  details: 'M4 5h16v14H4z M8 9h8 M8 13h5',
  close: 'M6 6l12 12 M18 6L6 18',
  chevronRight: 'M9 6l6 6-6 6',
  chevronDown: 'M6 9l6 6 6-6',
  refresh: 'M20 11a8 8 0 1 0-2.3 5.7 M20 4v7h-7',
  play: 'M7 5l12 7-12 7z',
  stop: 'M7 7h10v10H7z',
  fit: 'M4 9V4h5 M20 9V4h-5 M4 15v5h5 M20 15v5h-5',
  plus: 'M12 5v14 M5 12h14',
  minus: 'M5 12h14',
  horizontal: 'M4 12h16 M16 8l4 4-4 4',
  vertical: 'M12 4v16 M8 16l4 4 4-4',
  file: 'M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z M14 3v5h5',
  target: 'M12 3v4 M12 17v4 M3 12h4 M17 12h4 M12 8a4 4 0 1 0 0 8a4 4 0 0 0 0-8z',
  copy: 'M9 9h11v11H9z M5 15H4V4h11v1',
  check: 'M5 12l5 5 9-10',
  alert: 'M12 3l10 18H2z M12 10v4 M12 17.5v.5',
  sliders: 'M4 7h10 M18 7h2 M4 17h4 M12 17h8 M16 5v4 M10 15v4',
  database: 'M12 3c4.4 0 8 1.3 8 3s-3.6 3-8 3-8-1.3-8-3 3.6-3 8-3z M4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6 M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3',
  eye: 'M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z M12 9a3 3 0 1 0 0 6a3 3 0 0 0 0-6z',
  eyeOff: 'M3 3l18 18 M10.6 5.1A10 10 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-3.2 4.2 M6.6 6.6C3.9 8.4 2 12 2 12s3.5 7 10 7a9.7 9.7 0 0 0 5.4-1.6',
  pencil: 'M4 20h4L19 9l-4-4L4 16z M14 6l4 4',
  trash: 'M4 7h16 M10 11v6 M14 11v6 M6 7l1 13h10l1-13 M9 7V4h6v3',
  graph: 'M6 5a2 2 0 1 0 0 4a2 2 0 0 0 0-4z M18 5a2 2 0 1 0 0 4a2 2 0 0 0 0-4z M12 15a2 2 0 1 0 0 4a2 2 0 0 0 0-4z M7.5 8.5l3.5 6.5 M16.5 8.5L13 15',
  terminal: 'M4 6l6 6-6 6 M12 18h8',
  layers: 'M12 3l9 5-9 5-9-5z M3 13l9 5 9-5'
} as const

export type IconName = keyof typeof PATHS

/** An inline SVG icon, `size` CSS pixels square, in the text colour. */
export function icon(name: IconName, size = 14): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('width', String(size))
  svg.setAttribute('height', String(size))
  svg.setAttribute('aria-hidden', 'true')
  svg.setAttribute('class', `icon icon-${name}`)
  const path = document.createElementNS(SVG_NS, 'path')
  path.setAttribute('d', PATHS[name])
  svg.append(path)
  return svg
}
