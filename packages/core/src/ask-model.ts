import { generateText, type LanguageModel } from 'ai';

export interface AskModelOptions {
  model: LanguageModel;
  system: string;
  prompt: string;
  signal?: AbortSignal;
  providerOptions?: Parameters<typeof generateText>[0]['providerOptions'];
}

/**
 * One question to a model that has no tools: the text of its answer. For
 * helper work beside the agent loop, such as the approval reviewer.
 */
export async function askModel(options: AskModelOptions): Promise<string> {
  const result = await generateText({
    model: options.model,
    system: options.system,
    prompt: options.prompt,
    ...(options.signal ? { abortSignal: options.signal } : {}),
    ...(options.providerOptions ? { providerOptions: options.providerOptions } : {}),
  });
  return result.text;
}
