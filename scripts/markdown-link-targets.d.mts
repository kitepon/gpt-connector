export interface MissingPackedMarkdownTarget {
  readonly target: string;
  readonly resolved: string;
}

export function markdownLinkTargets(markdown: string): string[];

export function relativeMarkdownLinkTargets(markdown: string): string[];

export function missingPackedMarkdownTargets(options: {
  readonly markdownPath: string;
  readonly markdown: string;
  readonly packedPaths: ReadonlySet<string> | readonly string[];
}): MissingPackedMarkdownTarget[];
