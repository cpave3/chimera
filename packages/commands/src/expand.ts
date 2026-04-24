/**
 * Split a string into whitespace-separated arguments, treating balanced
 * double-quoted runs as a single argument. Backslash-escapes are not
 * recognized; keep the grammar small per design D3.
 */
export function splitArgs(s: string): string[] {
  const out: string[] = [];
  let i = 0;
  const n = s.length;
  while (i < n) {
    while (i < n && isSpace(s[i]!)) i += 1;
    if (i >= n) break;
    if (s[i] === '"') {
      i += 1;
      let start = i;
      let buf = '';
      while (i < n && s[i] !== '"') i += 1;
      buf = s.slice(start, i);
      out.push(buf);
      if (i < n) i += 1; // consume closing quote
    } else {
      const start = i;
      while (i < n && !isSpace(s[i]!)) i += 1;
      out.push(s.slice(start, i));
    }
  }
  return out;
}

function isSpace(c: string): boolean {
  return c === ' ' || c === '\t' || c === '\n' || c === '\r';
}

export interface ExpandArgs {
  args: string;
  cwd: string;
  date?: Date;
}

/**
 * Expand placeholders per spec §10.2 / commands spec. Unknown `$`-tokens
 * are left intact (so `$PATH` in shell snippets survives).
 *
 * Substitution order (matters when placeholders overlap lexically):
 *   1. `$ARGUMENTS` — entire raw args string
 *   2. `$CWD`, `$DATE` — env-ish scalars
 *   3. `$1`..`$9` — positional args (missing → empty string)
 */
export function expandBody(body: string, opts: ExpandArgs): string {
  const positionals = splitArgs(opts.args);
  const date = opts.date ?? new Date();

  let out = body;
  // 1. $ARGUMENTS — use a regex with a boundary that doesn't consume trailing
  //    chars; match literal $ARGUMENTS followed by a non-word char or EOS.
  out = out.replace(/\$ARGUMENTS\b/g, () => opts.args);
  // 2. $CWD, $DATE
  out = out.replace(/\$CWD\b/g, () => opts.cwd);
  out = out.replace(/\$DATE\b/g, () => formatDate(date));
  // 3. $1..$9 — careful not to match $10, $11, … (there's no $10 in the grammar,
  //    but be conservative and require a non-digit boundary).
  out = out.replace(/\$([1-9])(?!\d)/g, (_m, d: string) => {
    const idx = Number.parseInt(d, 10) - 1;
    return positionals[idx] ?? '';
  });
  return out;
}

function formatDate(d: Date): string {
  const y = d.getFullYear().toString().padStart(4, '0');
  const m = (d.getMonth() + 1).toString().padStart(2, '0');
  const day = d.getDate().toString().padStart(2, '0');
  return `${y}-${m}-${day}`;
}
