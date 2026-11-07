import { EdgeQueue, handleEdge } from "./core.ts";

const queue = new EdgeQueue();
export const served = handleEdge("request");
queue.push(served);
