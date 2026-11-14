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

/** A write to a path the agent may read and never change: its own rules, hooks or mods. */
export class ProtectedPathError extends Error {
  readonly path: string;
  constructor(path: string) {
    super(
      `Path '${path}' is protected: it holds the agent's own permission rules, hooks or mods, which only the user changes`,
    );
    this.name = 'ProtectedPathError';
    this.path = path;
  }
}
