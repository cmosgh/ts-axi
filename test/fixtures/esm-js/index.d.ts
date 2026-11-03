export default function limitQueue(concurrency: number): (task: () => unknown) => boolean;
export function drain<T>(queue: T[]): T[];
