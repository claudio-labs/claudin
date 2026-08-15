export interface ReplaceRule {
  pattern: RegExp;
  replacement: string;
  /** Skip this replace rule if the full text matches this pattern. */
  unless?: RegExp;
}

export interface MatchOutputRule {
  pattern: RegExp;
  message: string;
  unless?: RegExp;
}

export interface RewriteContext {
  command: string;
  verb: string;
  args: string[];
}
