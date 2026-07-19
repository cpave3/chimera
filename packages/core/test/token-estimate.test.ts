import type { ModelMessage } from 'ai';
import { describe, expect, it } from 'vitest';
import { estimateTokens } from '../src/context-tracker';
import { IMAGE_TOKEN_COST } from '../src/message-parts';

function dataUrl(base64Length: number): string {
  return `data:image/png;base64,${'A'.repeat(base64Length)}`;
}

function imageMessage(image: string): ModelMessage {
  return {
    role: 'user',
    content: [
      { type: 'text', text: 'here is a screenshot' },
      {
        type: 'image',
        image,
        providerOptions: { chimera: { sourcePath: '/w/shot.png', width: 3840, height: 2160 } },
      },
    ],
  } as ModelMessage;
}

function imageToolResult(data: string): ModelMessage {
  return {
    role: 'tool',
    content: [
      {
        type: 'tool-result',
        toolCallId: 'call-1',
        toolName: 'read',
        output: { type: 'json', value: { kind: 'image', data, mime: 'image/png' } },
      },
    ],
  } as ModelMessage;
}

function toolResult(content: string): ModelMessage {
  return {
    role: 'tool',
    content: [
      {
        type: 'tool-result',
        toolCallId: 'call-1',
        toolName: 'read',
        output: { type: 'json', value: { kind: 'file', content } },
      },
    ],
  } as ModelMessage;
}

describe('estimateTokens with images', () => {
  it('does not grow with the size of the image payload', () => {
    // The bug: base64 was measured as text, so cost tracked file size at
    // roughly bytes/3 instead of the image's real token cost.
    const small = estimateTokens([imageMessage(dataUrl(1_000))]);
    const large = estimateTokens([imageMessage(dataUrl(1_000_000))]);
    expect(small).toBe(large);
  });

  it('charges the same whether history stored a path or an inline data URL', () => {
    // Read-tool images used to persist as data URLs and user-attached ones as
    // paths. Rehydrated sessions still contain both.
    expect(estimateTokens([imageMessage('/w/shot.png')])).toBe(
      estimateTokens([imageMessage(dataUrl(500_000))]),
    );
  });

  it('does not charge for read-image tool-result payloads the model never sees', () => {
    // prepareMessagesForModel elides these before sending, so measuring them
    // charged for bytes that never left the machine.
    const small = estimateTokens([imageToolResult(dataUrl(1_000))]);
    const large = estimateTokens([imageToolResult(dataUrl(1_000_000))]);
    expect(small).toBe(large);
  });

  it('still charges for non-image tool results in full', () => {
    const short = estimateTokens([toolResult('x'.repeat(100))]);
    const long = estimateTokens([toolResult('x'.repeat(100_000))]);
    expect(long - short).toBeGreaterThan(24_000);
  });

  it('keeps a 512KB image read to the cost of one image', () => {
    // The reported scenario. One read produces both a tool result and an
    // injected image message, so the payload used to be counted twice:
    // ~350k tokens for an image that really costs ~1.8k.
    const payload = dataUrl(700_000);
    const estimate = estimateTokens([imageToolResult(payload), imageMessage(payload)]);
    expect(estimate).toBeLessThan(2_000);
  });

  it('leaves a session of three screenshots far below a 200k window', () => {
    const payload = dataUrl(700_000);
    const messages = [0, 1, 2].flatMap(() => [imageToolResult(payload), imageMessage(payload)]);
    expect(estimateTokens(messages)).toBeLessThan(6_000);
  });

  it('charges a larger long edge more for the same image', () => {
    const messages = [imageMessage('/w/shot.png')];
    expect(estimateTokens(messages, { imageLongEdge: 2576 })).toBeGreaterThan(
      estimateTokens(messages),
    );
  });

  it('falls back to a flat cost for an image with no recorded dimensions', () => {
    const withoutDims: ModelMessage = {
      role: 'user',
      content: [{ type: 'image', image: '/w/legacy.png' }],
    } as ModelMessage;
    const empty: ModelMessage = { role: 'user', content: [] } as ModelMessage;
    // The flat fallback, plus a few tokens for the part's own JSON skeleton.
    const delta = estimateTokens([withoutDims]) - estimateTokens([empty]);
    expect(delta).toBeGreaterThanOrEqual(IMAGE_TOKEN_COST);
    expect(delta).toBeLessThan(IMAGE_TOKEN_COST + 50);
  });
});
