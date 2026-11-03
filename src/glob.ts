// Small glob matcher for repo-root-relative `/` paths: `*`, `?`, `**`.
// Semantics follow minimatch defaults (dot: false, no matchBase): wildcards
// never match a segment that starts with `.`, and `*.ts` matches top level only.

const SEGMENT = "(?!\\.)[^/]+";

function escapeChar(ch: string): string {
  return /[\\^$.*+?()[\]{}|]/.test(ch) ? `\\${ch}` : ch;
}

function segmentSource(segment: string): string {
  let source = /^[*?]/.test(segment) ? "(?!\\.)" : "";
  for (const ch of segment) {
    if (ch === "*") source += "[^/]*";
    else if (ch === "?") source += "[^/]";
    else source += escapeChar(ch);
  }
  return source;
}

function normalise(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
}

export function hasGlobMagic(pattern: string): boolean {
  return /[*?]/.test(pattern);
}

/** Compile a glob to an anchored RegExp over a whole `/`-separated path. */
export function globToRegExp(glob: string): RegExp {
  const segments = normalise(glob).split("/");
  let source = "";
  segments.forEach((segment, i) => {
    const last = i === segments.length - 1;
    if (segment === "**") {
      // `a/**/b` matches `a/b`; a trailing `**` matches anything below (or nothing).
      source += last ? `(?:${SEGMENT}(?:/${SEGMENT})*)?` : `(?:${SEGMENT}/)*`;
      return;
    }
    source += segmentSource(segment) + (last ? "" : "/");
  });
  return new RegExp(`^${source}$`);
}

/**
 * True when `path` matches `glob`. A pattern without wildcards is a file or
 * directory prefix: `src/models` matches `src/models/user.ts`.
 */
export function matchesGlob(path: string, glob: string): boolean {
  const p = normalise(path);
  const g = normalise(glob);
  if (g === "" || g === ".") return true;
  if (!hasGlobMagic(g)) return p === g || p.startsWith(`${g}/`);
  return globToRegExp(g).test(p);
}
