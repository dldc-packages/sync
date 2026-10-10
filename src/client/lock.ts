export async function withLock<T>(name: string, fn: () => Promise<T>): Promise<T> {
  return await navigator.locks.request(name, { mode: "exclusive" }, fn);
}
