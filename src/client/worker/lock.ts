export function withLock<T>(name: string, fn: () => Promise<T>): Promise<T> {
  return navigator.locks.request(name, { mode: "exclusive" }, fn);
}
