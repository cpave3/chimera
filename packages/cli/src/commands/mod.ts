import declarations from '../../../mod-api/dist/declarations.json';

export interface ModCommandOptions {
  json?: boolean;
  stdout?: { write(text: string): unknown };
  stderr?: { write(text: string): unknown };
}

export async function runModTypes(options: ModCommandOptions = {}): Promise<number> {
  (options.stdout ?? process.stdout).write(declarations);
  return 0;
}

