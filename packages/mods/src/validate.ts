import { readFile, realpath } from 'node:fs/promises';
import { createRequire, isBuiltin } from 'node:module';
import { dirname, extname, join, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

async function commonJs(filename: string): Promise<boolean> {
  if (extname(filename) === '.cjs') return true;
  if (extname(filename) !== '.js') return false;
  let directory = dirname(filename);
  while (true) {
    try {
      const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
      return (
        manifest.type === 'commonjs' ||
        (manifest.type !== 'module' && filename.split(sep).includes('node_modules'))
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const parent = dirname(directory);
    if (directory === parent) return false;
    directory = parent;
  }
}

export async function validateModule(filename: string, visited = new Set<string>()): Promise<void> {
  filename = await realpath(filename);
  if (visited.has(filename)) return;
  visited.add(filename);
  const extension = extname(filename);
  const typescript = ['.mts', '.ts', '.cts'].includes(extension);
  if (typescript) {
    const [major, minor] = process.versions.node.split('.').map(Number);
    if (!process.versions.bun && (major < 22 || (major === 22 && minor < 18))) {
      throw new Error('.mts mods require Node 22.18 or newer');
    }
    if (filename.split(sep).includes('node_modules')) {
      throw new Error(`TypeScript under node_modules is not supported: ${filename}`);
    }
  }
  const source = ts.createSourceFile(
    filename,
    await readFile(filename, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    typescript ? ts.ScriptKind.TS : ts.ScriptKind.JS,
  );
  const imports: string[] = [];
  const reject = (detail: string): never => {
    throw new Error(`Invalid mod module ${filename}: ${detail}`);
  };
  if ((await commonJs(filename)) && ts.isExternalModule(source)) {
    reject('ES module syntax is not valid in a CommonJS .js/.cjs file; use .mjs or type:module');
  }
  const visit = (node: ts.Node): void => {
    if (
      ts.isEnumDeclaration(node) ||
      ts.isImportEqualsDeclaration(node) ||
      ts.isExportAssignment(node)
    ) {
      reject(
        'only erasable TypeScript is supported (no enums, import aliases or export assignments)',
      );
    }
    if (
      ts.isModuleDeclaration(node) &&
      !(ts.getCombinedModifierFlags(node) & ts.ModifierFlags.Ambient)
    ) {
      reject('runtime TypeScript namespaces are not supported');
    }
    if (
      ts.isParameter(node) &&
      ts.isConstructorDeclaration(node.parent) &&
      node.modifiers?.length
    ) {
      reject('constructor parameter properties are not supported');
    }
    if (ts.isDecorator(node)) reject('decorators are not supported by Node 22.18');
    if (ts.isImportDeclaration(node)) {
      if (node.importClause?.isTypeOnly) return;
      if (
        node.importClause?.namedBindings &&
        ts.isNamedImports(node.importClause.namedBindings) &&
        node.importClause.namedBindings.elements.some((element) => element.isTypeOnly)
      ) {
        reject('use top-level import type, not inline type imports');
      }
      imports.push((node.moduleSpecifier as ts.StringLiteral).text);
    }
    if (ts.isExportDeclaration(node)) {
      if (node.isTypeOnly) return;
      if (
        node.exportClause &&
        ts.isNamedExports(node.exportClause) &&
        node.exportClause.elements.some((element) => element.isTypeOnly)
      ) {
        reject('use top-level export type, not inline type exports');
      }
      if (node.moduleSpecifier) imports.push((node.moduleSpecifier as ts.StringLiteral).text);
    }
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments[0] &&
      ts.isStringLiteralLike(node.arguments[0])
    ) {
      imports.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  for (const specifier of imports) {
    if (isBuiltin(specifier)) continue;
    let target: string;
    if (specifier.startsWith('.') || specifier.startsWith('/') || specifier.startsWith('file:')) {
      const url = new URL(specifier, pathToFileURL(filename));
      if (!extname(url.pathname))
        reject(`relative imports need real file extensions: ${specifier}`);
      target = fileURLToPath(url);
    } else {
      const runtime = globalThis as unknown as {
        Bun?: { resolveSync(specifier: string, parent: string): string };
      };
      if (runtime.Bun) {
        target = runtime.Bun.resolveSync(specifier, dirname(filename));
      } else {
        try {
          target = createRequire(pathToFileURL(filename)).resolve(specifier);
        } catch {
          // require.resolve cannot resolve import-only exports; Node's import validates them.
          continue;
        }
      }
    }
    if (['.mjs', '.mts', '.ts', '.cts', '.js', '.cjs'].includes(extname(target))) {
      await validateModule(target, visited);
    }
  }
}
