// The slice of marked 18.3's API that ui/markdown.ts uses.
export type MarkedOptions = {
  gfm?: boolean
  breaks?: boolean
  renderer?: { html?: (token: { text: string }) => string }
}

export class Marked {
  constructor(...extensions: MarkedOptions[])
  parse(source: string, options: { async: false }): string
}
