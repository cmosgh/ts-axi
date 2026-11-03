export function parse(q: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of q.replace(/^\?/, '').split('&')) {
    if (!pair) continue;
    const [k, v = ''] = pair.split('=');
    out[decodeURIComponent(k)] = decodeURIComponent(v);
  }
  return out;
}
