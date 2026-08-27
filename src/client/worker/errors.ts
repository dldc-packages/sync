export class UnauthorizedError extends Error {
  constructor(message = "Unauthorized (401)") {
    super(message);
    this.name = "UnauthorizedError";
  }
}

export function assertOk(res: Response): void {
  if (res.ok) {
    return;
  }
  if (res.status === 401) {
    throw new UnauthorizedError();
  }
  throw new Error(`Request failed with status ${res.status}`);
}
