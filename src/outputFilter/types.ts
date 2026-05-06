export interface ReplaceRule {
  pattern: RegExp;
  replacement: string;
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
