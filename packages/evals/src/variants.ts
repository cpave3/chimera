export interface Variant {
  id: string;
  description: string;
  /** Merged into the model's entry under `models` in config.json. */
  modelOptions?: Record<string, unknown>;
  /** Merged into the provider's entry under `providers` in config.json. */
  providerOptions?: Record<string, unknown>;
  /** Extra `chimera run` flags. */
  flags?: string[];
  /** A mode written to the eval home and selected with `--mode`. */
  mode?: { name: string; tools: string[] };
}

export const VARIANTS: Variant[] = [
  {
    id: 'guided',
    description: 'The profile an unknown model gets today: guided prompt, exact-string edits.',
    modelOptions: { promptStyle: 'guided' },
  },
  {
    id: 'lean',
    description: 'The prompt Claude and GPT get: no working-method rules.',
    modelOptions: { promptStyle: 'lean' },
  },
  {
    id: 'patch',
    description: 'Guided prompt, with apply_patch in place of the exact-string edit tool.',
    modelOptions: { promptStyle: 'guided', editFormat: 'patch' },
  },
  {
    id: 'compatible',
    description:
      'Guided prompt over the OpenAI-compatible adapter, which reads the reasoning_content of a thinking model.',
    modelOptions: { promptStyle: 'guided' },
    providerOptions: { adapter: 'compatible' },
  },
  {
    id: 'core-tools',
    description: 'Guided prompt, with only read, edit, write, glob, grep and bash.',
    modelOptions: { promptStyle: 'guided' },
    flags: ['--no-skills', '--no-subagents'],
    mode: { name: 'eval-core', tools: ['read', 'edit', 'write', 'glob', 'grep', 'bash'] },
  },
];

export function findVariant(id: string): Variant {
  const variant = VARIANTS.find((candidate) => candidate.id === id);
  if (!variant) {
    const known = VARIANTS.map((candidate) => candidate.id).join(', ');
    throw new Error(`Unknown variant "${id}". Known variants: ${known}`);
  }
  return variant;
}
