export interface TDeferred<T, Err = unknown> {
  readonly resolve: (value: T) => void;
  readonly reject: (error: Err) => void;
  readonly promise: Promise<T>;
}

export function createDeferred<T, Err = unknown>(): TDeferred<T, Err> {
  let actions: null | {
    resolve: (value: T) => void;
    reject: (error: Err) => void;
  } = null;

  const promise = new Promise<T>((resolve, reject) => {
    actions = { resolve, reject };
  });

  return {
    resolve,
    reject,
    promise,
  };

  function resolve(value: T) {
    if (actions === null) {
      throw new Error("Deferred: not initialized");
    }
    actions.resolve(value);
  }

  function reject(error: Err) {
    if (actions === null) {
      throw new Error("Deferred: not initialized");
    }
    actions.reject(error);
  }
}
