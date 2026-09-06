import type { MetadataExtractor } from '@ai-sdk/openai-compatible';
import type { JSONValue, LanguageModelMiddleware } from 'ai';

// The compatible SDK drops unknown response fields. Retain only opaque Codex
// reasoning items, then attach them to tool calls through its metadata escape
// hatch. They are never converted into assistant text.
function itemsFrom(value: unknown): JSONValue[] {
  const body = value as {
    choices?: Array<{
      message?: { codex_reasoning?: JSONValue[] };
      delta?: { codex_reasoning?: JSONValue[] };
    }>;
  };
  const items =
    body?.choices?.[0]?.message?.codex_reasoning ?? body?.choices?.[0]?.delta?.codex_reasoning;
  return Array.isArray(items) ? items : [];
}

export const codexMetadataExtractor: MetadataExtractor = {
  async extractMetadata({ parsedBody }) {
    return { chimera: { codexReasoning: itemsFrom(parsedBody) } };
  },
  createStreamExtractor() {
    const items: JSONValue[] = [];
    return {
      processChunk(chunk) {
        items.push(...itemsFrom(chunk));
      },
      buildMetadata() {
        return { chimera: { codexReasoning: items } };
      },
    };
  },
};

export const codexContinuationMiddleware: LanguageModelMiddleware = {
  specificationVersion: 'v3',
  async wrapGenerate({ doGenerate }) {
    const result = await doGenerate();
    const items = result.providerMetadata?.chimera?.codexReasoning;
    if (!Array.isArray(items) || !items.length) return result;
    return {
      ...result,
      content: result.content.map((part) =>
        part.type !== 'tool-call'
          ? part
          : {
              ...part,
              providerMetadata: {
                ...part.providerMetadata,
                openaiCompatible: {
                  ...part.providerMetadata?.openaiCompatible,
                  codex_reasoning: items,
                },
              },
            },
      ),
    };
  },
  async wrapStream({ doStream, doGenerate }) {
    const result = await doStream();
    const pending: Array<
      Extract<Awaited<ReturnType<typeof doGenerate>>['content'][number], { type: 'tool-call' }>
    > = [];
    return {
      ...result,
      stream: result.stream.pipeThrough(
        new TransformStream({
          transform(part, controller) {
            if (part.type === 'tool-call') {
              pending.push(part);
              return;
            }
            if (part.type === 'finish') {
              const items = part.providerMetadata?.chimera?.codexReasoning;
              for (const call of pending)
                controller.enqueue(
                  !Array.isArray(items) || !items.length
                    ? call
                    : {
                        ...call,
                        providerMetadata: {
                          ...call.providerMetadata,
                          openaiCompatible: {
                            ...call.providerMetadata?.openaiCompatible,
                            codex_reasoning: items,
                          },
                        },
                      },
                );
              pending.length = 0;
            }
            controller.enqueue(part);
          },
        }),
      ),
    };
  },
};
