import { encode } from "@toon-format/toon";

export type Obj = Record<string, unknown>;

/** Encode one structured block as TOON. */
export function block(value: Obj): string {
  return encode(value);
}

/**
 * Render next-step suggestions one per line. `encode()` would inline a
 * primitive array as a single comma-joined (and quoted) line, which is harder
 * to read and costs more tokens once commands contain commas or quotes.
 */
export function helpBlock(lines: readonly string[]): string {
  if (lines.length === 0) return "";
  return `help[${lines.length}]:\n${lines.map((l) => `  ${l}`).join("\n")}`;
}

/** Join blocks into one stdout payload, skipping empty ones. */
export function out(...blocks: Array<string | false | undefined>): string {
  return blocks.filter((b): b is string => Boolean(b)).join("\n");
}

export function renderErrorOutput(
  message: string,
  code: string,
  suggestions: readonly string[],
): string {
  return out(block({ error: message, code }), helpBlock(suggestions));
}

export interface Truncated {
  text: string;
  truncated: boolean;
  total: number;
}

/** Truncate with a size hint so the agent knows how much it is missing. */
export function truncate(text: string, limit: number): Truncated {
  if (text.length <= limit) {
    return { text, truncated: false, total: text.length };
  }
  return {
    text: `${text.slice(0, limit).trimEnd()}\n... (truncated, ${text.length} chars total)`,
    truncated: true,
    total: text.length,
  };
}

/** Keep the END of a text (logs fail at the bottom). */
export function truncateTail(text: string, limit: number): Truncated {
  if (text.length <= limit) {
    return { text, truncated: false, total: text.length };
  }
  const tail = text.slice(text.length - limit);
  const firstBreak = tail.indexOf("\n");
  const clean = firstBreak === -1 ? tail : tail.slice(firstBreak + 1);
  return {
    text: `... (truncated, showing last ${clean.length} of ${text.length} chars)\n${clean}`,
    truncated: true,
    total: text.length,
  };
}

export function relTime(iso: unknown, now: number = Date.now()): string {
  if (typeof iso !== "string" || iso === "") return "unknown";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "unknown";
  const sec = Math.floor((now - then) / 1000);
  if (sec < 60) return "just now";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day}d ago`;
  const mon = Math.floor(day / 30);
  if (mon < 12) return `${mon}mo ago`;
  return `${Math.floor(mon / 12)}y ago`;
}

export function duration(seconds: unknown): string {
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0) {
    return "unknown";
  }
  const s = Math.round(seconds);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** "N of T total" when the backend knows the total, otherwise an honest bound. */
/** Exact counts stay numbers so TOON renders them unquoted. */
export function countLine(shown: number, total: number | undefined, more: boolean): string | number {
  if (total !== undefined && total >= shown) {
    return total === shown ? shown : `${shown} of ${total} total`;
  }
  return more ? `${shown}+ (more available)` : shown;
}

// --- loose JSON accessors: API payloads are untyped, keep narrowing in one place ---

export function obj(value: unknown): Obj {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Obj)
    : {};
}

export function arr(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function dig(value: unknown, ...path: string[]): unknown {
  let current: unknown = value;
  for (const key of path) {
    current = obj(current)[key];
  }
  return current;
}
