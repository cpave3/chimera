export class ChimeraHttpError extends Error {
  readonly status: number;
  readonly body: unknown;
  constructor(status: number, body: unknown, message?: string) {
    super(message ?? `HTTP ${status}`);
    this.name = 'ChimeraHttpError';
    this.status = status;
    this.body = body;
  }
}

export class PermissionAlreadyResolvedError extends Error {
  readonly requestId: string;
  constructor(requestId: string) {
    super(`Permission request ${requestId} is already resolved`);
    this.name = 'PermissionAlreadyResolvedError';
    this.requestId = requestId;
  }
}
