export class PathEscapeError extends Error {
  readonly path: string;
  readonly cwd: string;
  constructor(path: string, cwd: string) {
    super(`Path '${path}' escapes working directory '${cwd}'`);
    this.name = 'PathEscapeError';
    this.path = path;
    this.cwd = cwd;
  }
}
