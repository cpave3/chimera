import type { ModelMessage } from 'ai';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_IMAGE_LONG_EDGE,
  IMAGE_ELISION_PLACEHOLDER,
  IMAGE_TOKEN_COST,
  countImageParts,
  elideImageToolResults,
  estimateImageTokens,
  imageDimensions,
  isImagePart,
} from '../src/message-parts';

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

describe('estimateImageTokens', () => {
  it('charges an image smaller than the long edge at its true pixel count', () => {
    // 200*200/750 = 53.3
    expect(estimateImageTokens({ width: 200, height: 200 }, DEFAULT_IMAGE_LONG_EDGE)).toBe(54);
  });

  it('scales a 4K screenshot to the long edge before charging for it', () => {
    // 3840x2160 -> scale 1568/3840 -> 1568x882 -> 1382976/750 = 1844.
    // Charging the unscaled 8.3MP would cost 11059 — the bug this avoids.
    expect(estimateImageTokens({ width: 3840, height: 2160 }, DEFAULT_IMAGE_LONG_EDGE)).toBe(1844);
  });

  it('falls back to a flat cost when dimensions are unknown', () => {
    // Sessions written before dimensions were captured, and images whose
    // header we cannot parse.
    expect(estimateImageTokens(undefined, DEFAULT_IMAGE_LONG_EDGE)).toBe(IMAGE_TOKEN_COST);
  });

  it('charges more per image on a higher-resolution tier', () => {
    const standard = estimateImageTokens({ width: 3840, height: 2160 }, DEFAULT_IMAGE_LONG_EDGE);
    const highRes = estimateImageTokens({ width: 3840, height: 2160 }, 2576);
    expect(highRes).toBeGreaterThan(standard);
  });
});

describe('imageDimensions', () => {
  it('reads dimensions recorded on the part', () => {
    const part = {
      type: 'image',
      image: '/w/shot.png',
      providerOptions: { chimera: { sourcePath: '/w/shot.png', width: 3840, height: 2160 } },
    };
    expect(imageDimensions(part)).toEqual({ width: 3840, height: 2160 });
  });

  it('returns undefined when the part carries no dimensions', () => {
    expect(imageDimensions({ type: 'image', image: '/w/shot.png' })).toBeUndefined();
    expect(
      imageDimensions({
        type: 'image',
        image: '/w/shot.png',
        providerOptions: { chimera: { sourcePath: '/w/shot.png' } },
      }),
    ).toBeUndefined();
  });
});

describe('isImagePart', () => {
  it('recognises an image part in either stored form', () => {
    expect(isImagePart({ type: 'image', image: '/w/shot.png' })).toBe(true);
    expect(isImagePart({ type: 'image', image: 'data:image/png;base64,AAAA' })).toBe(true);
  });

  it('rejects anything that is not an image part', () => {
    expect(isImagePart({ type: 'text', text: 'hello' })).toBe(false);
    expect(isImagePart(undefined)).toBe(false);
  });
});

describe('countImageParts', () => {
  it('counts image parts and ignores everything else', () => {
    expect(
      countImageParts([
        { type: 'text', text: 'look at these' },
        { type: 'image', image: '/w/a.png' },
        { type: 'image', image: '/w/b.png' },
      ]),
    ).toBe(2);
  });

  it('counts nothing for string content', () => {
    expect(countImageParts('hello')).toBe(0);
  });
});

describe('elideImageToolResults', () => {
  it('replaces the base64 payload of a read-image result', () => {
    const elided = elideImageToolResults(imageToolResult('data:image/png;base64,AAAA'));
    const output = (
      elided.content as Array<{ output: { value: { data: string; mime: string } } }>
    )[0]!.output;
    expect(output.value.data).toBe(IMAGE_ELISION_PLACEHOLDER);
    expect(output.value.mime).toBe('image/png');
  });

  it('leaves a message without image results untouched', () => {
    const message: ModelMessage = {
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          toolCallId: 'call-1',
          toolName: 'read',
          output: { type: 'json', value: { kind: 'file', content: 'hello' } },
        },
      ],
    } as ModelMessage;
    expect(elideImageToolResults(message)).toBe(message);
  });

  it('leaves a string-content message untouched', () => {
    const message: ModelMessage = { role: 'user', content: 'hello' };
    expect(elideImageToolResults(message)).toBe(message);
  });
});
