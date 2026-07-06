import { extname } from 'node:path';
import { z } from 'zod';
import type { ToolContext } from './context';
import { defineTool } from './define';
import { relPath } from './format';

const MAX_LINES = 2000;
const MAX_BYTES = 100 * 1024;
const MAX_DIR_ENTRIES = 200;

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp']);
const EXT_TO_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
};

function isImageFile(path: string): boolean {
  return IMAGE_EXTS.has(extname(path).toLowerCase());
}

const READ_SCHEMA = z.object({
  path: z.string(),
  start_line: z.number().int().positive().optional(),
  end_line: z.number().int().positive().optional(),
});
type ReadArgs = z.infer<typeof READ_SCHEMA>;
type ReadFileResult = {
  kind: 'file';
  content: string;
  total_lines: number;
  truncated: boolean;
};
type ReadDirResult = {
  kind: 'directory';
  entries: { name: string; isDir: boolean }[];
  truncated: boolean;
};
type ReadImageResult = {
  kind: 'image';
  data: string;
  mime: string;
};
type ReadResult = ReadFileResult | ReadDirResult | ReadImageResult;

export function buildReadTool(ctx: ToolContext) {
  const cwd = ctx.sandboxExecutor.cwd();
  return defineTool<ReadArgs, ReadResult>({
    description:
      'Read a file from the working directory or /tmp. Returns line-number-prefixed content. ' +
      'Limited to 2000 lines or 100 KB (whichever is smaller); specify start_line/end_line to read a slice. ' +
      'When the path is a directory, returns its entries instead — use `glob` for recursive discovery. ' +
      'Image files (.png, .jpg, .jpeg, .gif, .webp, .bmp) are returned as base64 data URIs suitable for vision models.',
    inputSchema: READ_SCHEMA,
    execute: async (args) => {
      const stat = await ctx.sandboxExecutor.stat(args.path);
      if (stat?.isDir) {
        const entries = await ctx.sandboxExecutor.readdir(args.path);
        const truncated = entries.length > MAX_DIR_ENTRIES;
        return {
          kind: 'directory',
          entries: truncated ? entries.slice(0, MAX_DIR_ENTRIES) : entries,
          truncated,
        };
      }

      // Detect images by extension and return a base64 data URI so the agent
      // can inject them into the conversation as vision inputs.
      if (isImageFile(args.path)) {
        const bytes = await ctx.sandboxExecutor.readFileBytes(args.path);
        const ext = extname(args.path).toLowerCase();
        const mime = EXT_TO_MIME[ext] ?? 'image/png';
        const base64 = Buffer.from(bytes).toString('base64');
        return { kind: 'image', data: `data:${mime};base64,${base64}`, mime };
      }

      const raw = await ctx.sandboxExecutor.readFile(args.path);
      const allLines = raw.split('\n');
      // If the file ends with \n, split yields a trailing empty string; drop it
      // so `total_lines` matches what users expect.
      if (allLines.length > 0 && allLines[allLines.length - 1] === '') {
        allLines.pop();
      }
      const total = allLines.length;

      const startIdx = args.start_line ? Math.max(1, args.start_line) : 1;
      const endIdx = args.end_line ? Math.min(total, args.end_line) : total;
      const sliced = allLines.slice(startIdx - 1, endIdx);

      let truncated = false;
      const capped: string[] = [];
      let byteCount = 0;
      for (let i = 0; i < sliced.length && i < MAX_LINES; i += 1) {
        const line = sliced[i] ?? '';
        const prefixed = `${startIdx + i}\t${line}`;
        const bytes = Buffer.byteLength(prefixed, 'utf8') + 1;
        if (byteCount + bytes > MAX_BYTES) {
          truncated = true;
          break;
        }
        capped.push(prefixed);
        byteCount += bytes;
      }
      if (sliced.length > MAX_LINES) truncated = true;

      return {
        kind: 'file',
        content: capped.join('\n'),
        total_lines: total,
        truncated,
      };
    },
    formatScrollback: (args, result) => {
      const range = args.start_line ? `:${args.start_line}-${args.end_line ?? ''}` : '';
      const head = `${relPath(args.path, cwd)}${range}`;
      if (!result) return { summary: head };
      if (result.kind === 'directory') {
        const tail = result.truncated
          ? ` (${result.entries.length}+ entries, truncated)`
          : ` (${result.entries.length} entries)`;
        return { summary: `${head}/${tail}` };
      }
      if (result.kind === 'image') {
        return { summary: `${head} (image)` };
      }
      const isSlice = args.start_line !== undefined || args.end_line !== undefined;
      const returned = result.content === '' ? 0 : result.content.split('\n').length;
      const lines = isSlice
        ? `${returned} of ${result.total_lines} lines`
        : `${result.total_lines} lines`;
      const tail = result.truncated ? ` (${lines}, truncated)` : ` (${lines})`;
      return { summary: `${head}${tail}` };
    },
  });
}
