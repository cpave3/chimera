import type { ModelMessage } from 'ai';
import type { FileOps } from '@chimera/core';

export function formatFilesBlock(fileOps: FileOps): string {
  const reads = sortedPaths(fileOps.reads).filter((path) => !fileOps.writes.has(path));
  const modified = sortedPaths(fileOps.writes);
  const lines: string[] = ['<files>'];
  for (const path of reads) {
    lines.push(`  <read>${path}</read>`);
  }
  for (const path of modified) {
    lines.push(`  <modified>${path}</modified>`);
  }
  lines.push('</files>');
  return lines.join('\n');
}

function sortedPaths(set: Set<string>): string[] {
  return Array.from(set).sort();
}

export interface BuildPromptInput {
  toSummarize: ModelMessage[];
  previousSummaryContent?: string;
  fileOps: FileOps;
}

export function buildCompactionPrompt(input: BuildPromptInput): string {
  const parts: string[] = [
    'Summarize the following conversation history into a structured summary with exactly these section headers, in this order, terminated by a <files> XML block:',
    '',
    '## Goal',
    '## Constraints',
    '## Progress',
    '### Done',
    '### In Progress',
    '### Blocked',
    '## Key Decisions',
    '## Next Steps',
    '## Critical Context',
    '<files>',
    '  <read>...</read>',
    '  <modified>...</modified>',
    '</files>',
    '',
    'Include the <files> block exactly as shown in the example above. List all read and modified files from the provided file operations. A file that was written or edited must appear under <modified> only, even if it was also read.',
    '',
  ];

  if (input.previousSummaryContent) {
    parts.push(
      'The first message is a previous compaction summary. Merge its content with the new context and do NOT restate everything from scratch. Keep prior facts and merge them with any new decisions or progress.',
    );
    parts.push('');
  }

  parts.push('Conversation history:');
  parts.push('');
  for (const msg of input.toSummarize) {
    const text = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
    parts.push(`--- ${msg.role} ---`);
    parts.push(text);
  }

  parts.push('');
  parts.push('File operations during this session:');
  parts.push(formatFilesBlock(input.fileOps));
  parts.push('');
  parts.push('Produce the summary only, with no extra commentary.');

  return parts.join('\n');
}
