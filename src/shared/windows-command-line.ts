/** Quote a single argument for Windows command-line parsing, including a trailing backslash. */
export function quoteWindowsArgument(value: string): string {
  return '"' + value.replace(/(\\*)("|$)/g, (_match, slashes: string, quote: string) =>
    slashes.repeat(2) + (quote ? '\\"' : '')) + '"'
}
