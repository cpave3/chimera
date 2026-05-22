export class PathEscapeError extends Error {
  readonly path: string;
  readonly cwd: string;
  constructor(path: string, cwd: string) {
    super(`Path '${path}' is outside the working directory or permitted directories`);
    this.name = 'PathEscapeError';
    this.path = path;
    this.cwd = cwd;
  }
}
