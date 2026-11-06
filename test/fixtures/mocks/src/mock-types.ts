// Local stand-ins for test-library mock types (no dependencies).
export interface MockInstance<A extends unknown[], R> {
  mockResolvedValue(value: Awaited<R>): this;
  mockReturnValue(value: R): this;
  calls: A[];
}
/** `{ [K in keyof T]: mock & fn } & T`, like a deep-mock helper. */
export type DeepMocked<T> = {
  [K in keyof T]: Required<T>[K] extends (...args: infer A) => infer R ? MockInstance<A, R> & ((...args: A) => R) : T[K];
} & T;
/** A mapped type without `& T`. */
export type Mocked<T> = {
  [K in keyof T]: T[K] extends (...args: infer A) => infer R ? MockInstance<A, R> & ((...args: A) => R) : T[K];
};
/** A proxy type joined with `T`. */
export type MockProxy<T> = { [K in keyof T]: T[K] } & T;
export declare function expectCalled(fn: unknown): void;
