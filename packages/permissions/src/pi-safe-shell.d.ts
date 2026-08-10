declare module '@aslamplr/pi-safe-shell/src/ast-analyzer.ts' {
  export interface PiSafeShellAnalysis {
    command: string;
    executable: string;
    args: string[];
    flags: string[];
    hasPipe: boolean;
    hasRedirect: boolean;
    paths: string[];
    intent: string[];
  }

  export function initParser(): Promise<void>;
  export function analyzeCommand(command: string): PiSafeShellAnalysis;
}

declare module '@aslamplr/pi-safe-shell/src/ast-analyzer-v2.ts' {
  import type { PiSafeShellAnalysis } from '@aslamplr/pi-safe-shell/src/ast-analyzer.ts';

  export interface PiSafeShellRisk {
    score: number;
    level: 'safe' | 'caution' | 'danger' | 'critical';
    reasons: string[];
    riskFactors: string[];
  }

  export function scoreCommandV2(analysis: PiSafeShellAnalysis): PiSafeShellRisk;
}
