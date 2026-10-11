export interface ContextBarInput {
  /** Tokens of the last prompt, as the provider counted them. */
  used: number;
  window: number;
  /** Estimated size of the system prompt, skills index included; 0 when not known. */
  systemTokens: number;
  /** Estimated size of the skills index inside the system prompt. */
  skillsTokens: number;
  /** Cells the bar has. */
  cells: number;
}

/** Cells of the bar by what fills them; the four numbers add up to `cells`. */
export interface ContextBarCells {
  system: number;
  skills: number;
  history: number;
  free: number;
}

/**
 * Split a context gauge into system prompt, skills index and conversation.
 * The provider's count is the truth for the total; the system and skills
 * figures are estimates, so they are capped by it, and history is the rest.
 */
export function contextBar(input: ContextBarInput): ContextBarCells {
  const { used, window, cells } = input;
  if (window <= 0 || used <= 0 || cells <= 0) {
    return { system: 0, skills: 0, history: 0, free: Math.max(0, cells) };
  }
  const filled = Math.max(1, Math.min(cells, Math.round((used / window) * cells)));
  const systemTotal = Math.min(used, Math.max(0, input.systemTokens));
  const skills = Math.min(systemTotal, Math.max(0, input.skillsTokens));
  const tokens = { system: systemTotal - skills, skills, history: used - systemTotal };
  const names = ['system', 'skills', 'history'] as const;

  // Largest remainder, after every part that exists has its one cell.
  const present = names.filter((name) => tokens[name] > 0);
  const result = { system: 0, skills: 0, history: 0 };
  if (filled < present.length) {
    // Too few cells for a cell each: the largest parts take them.
    for (const name of [...present].sort((a, b) => tokens[b] - tokens[a]).slice(0, filled)) {
      result[name] = 1;
    }
    return { ...result, free: cells - filled };
  }
  for (const name of present) result[name] = 1;
  let spare = filled - present.length;
  const shares = present.map((name) => ({ name, exact: (tokens[name] / used) * spare }));
  for (const share of shares) {
    result[share.name] += Math.floor(share.exact);
    spare -= Math.floor(share.exact);
  }
  const byRemainder = [...shares].sort((a, b) => (b.exact % 1) - (a.exact % 1));
  for (let index = 0; spare > 0; index = (index + 1) % byRemainder.length) {
    result[byRemainder[index]!.name] += 1;
    spare -= 1;
  }
  return { ...result, free: cells - filled };
}
