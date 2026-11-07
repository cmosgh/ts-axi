export const EDGE_LIMIT = 10;

export function handleEdge(input: string): string {
  return input.slice(0, EDGE_LIMIT);
}

export class EdgeQueue {
  push(item: string): number {
    return handleEdge(item).length;
  }
}
