export default function limitQueue(concurrency) {
  const queue = [];
  return function enqueue(task) {
    queue.push(task);
    return queue.length <= concurrency;
  };
}

export function drain(queue) {
  return queue.splice(0);
}
