export interface EvalModel {
  /** Short name for flags, reports and file paths. */
  id: string;
  /** The model key the local server knows (`lms ls`). */
  key: string;
}

export const MODELS: EvalModel[] = [
  { id: 'qwen3.5-9b', key: 'qwen/qwen3.5-9b' },
  { id: 'gemma-4-12b', key: 'google/gemma-4-12b-qat' },
  { id: 'qwen3.8-27b', key: 'qwen/qwen3.8-27b' },
  { id: 'gemma-4-26b', key: 'google/gemma-4-26b-a4b' },
  { id: 'qwen3.6-35b', key: 'qwen/qwen3.6-35b-a3b' },
];

export const DEFAULT_MODEL_IDS = ['qwen3.5-9b', 'gemma-4-12b', 'qwen3.8-27b'];

/** A model from the table by id or key. Any other name is taken as a model key of the server. */
export function findModel(name: string): EvalModel {
  const known = MODELS.find((model) => model.id === name || model.key === name);
  return known ?? { id: name.replaceAll('/', '-'), key: name };
}
