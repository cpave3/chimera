type ProviderOptions = Record<string, Record<string, unknown>>;

/**
 * Mark the two points an agent loop reuses on every step: the end of the
 * system prompt (which also covers the tool definitions, since the provider
 * orders the prefix tools → system → messages) and the end of the
 * conversation so far. The next request reads everything up to the previous
 * end-of-conversation marker from the cache.
 */
export function markCacheBreakpoints<T extends { role: string; providerOptions?: unknown }>(
  prompt: T[],
): T[] {
  let lastSystemIndex = -1;
  for (let index = prompt.length - 1; index >= 0; index--) {
    if (prompt[index]?.role === 'system') {
      lastSystemIndex = index;
      break;
    }
  }
  const lastIndex = prompt.length - 1;
  return prompt.map((message, index) => {
    if (index !== lastSystemIndex && index !== lastIndex) return message;
    const providerOptions = message.providerOptions as ProviderOptions | undefined;
    return {
      ...message,
      providerOptions: {
        ...providerOptions,
        anthropic: { ...providerOptions?.anthropic, cacheControl: { type: 'ephemeral' } },
      },
    };
  });
}
