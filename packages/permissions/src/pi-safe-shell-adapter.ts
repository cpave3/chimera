import { analyzeCommand, initParser } from '@aslamplr/pi-safe-shell/src/ast-analyzer.ts';
import { scoreCommandV2 } from '@aslamplr/pi-safe-shell/src/ast-analyzer-v2.ts';
import type { CommandRiskClassifier, ParsedShellCommand, ShellCommandParser } from './types';

let parserInitialization: Promise<void> | undefined;

async function parse(command: string): Promise<ParsedShellCommand> {
  parserInitialization ??= initParser();
  await parserInitialization;
  return analyzeCommand(command);
}

export class PiSafeShellAdapter implements CommandRiskClassifier, ShellCommandParser {
  async classify(command: string) {
    const analysis = await parse(command);
    return scoreCommandV2(analysis);
  }

  parse(command: string): Promise<ParsedShellCommand> {
    return parse(command);
  }
}
