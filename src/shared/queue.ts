export interface TQueue {
  run<T>(task: () => Promise<T>): Promise<T>;
  end(): Promise<void>;
}

function createAbortError(): Error {
  try {
    return new DOMException("The operation was aborted", "AbortError");
  } catch {
    const error = new Error("The operation was aborted");
    error.name = "AbortError";
    return error;
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw createAbortError();
  }
}

export function createQueue(signal?: AbortSignal): TQueue {
  let currentPromise: Promise<void> = Promise.resolve();

  return {
    run,
    end,
  };

  function run<T>(task: () => Promise<T>): Promise<T> {
    const resultPromise = currentPromise.then(async () => {
      // Abort only prevents tasks that have not started yet.
      throwIfAborted(signal);
      return await task();
    });
    currentPromise = resultPromise.then(() => undefined, () => undefined);
    return resultPromise;
  }

  function end(): Promise<void> {
    return currentPromise;
  }
}
