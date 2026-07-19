import type { ModelMessage } from 'ai';
import type { ImageDimensions } from './image-header';

/** Long-edge pixel limit images are scaled to fit before they reach a provider. */
export const DEFAULT_IMAGE_LONG_EDGE = 1568;

/** Stands in for a read-image tool result's base64 in the prompt copy. */
export const IMAGE_ELISION_PLACEHOLDER = '[image data elided — see accompanying image message]';

export interface ImagePart {
  type: 'image';
  image: string;
  providerOptions?: unknown;
}

export function isImagePart(part: unknown): part is ImagePart {
  const candidate = part as { type?: unknown; image?: unknown };
  return candidate?.type === 'image' && typeof candidate.image === 'string';
}

/** The base64 payload of a read-image tool result, or undefined for anything else. */
export function imageToolResultData(part: unknown): string | undefined {
  const candidate = part as { type?: unknown; output?: { value?: unknown } };
  if (candidate?.type !== 'tool-result') return undefined;
  const value = candidate.output?.value as { kind?: unknown; data?: unknown } | undefined;
  if (!value || typeof value !== 'object' || value.kind !== 'image') return undefined;
  return typeof value.data === 'string' ? value.data : undefined;
}

export function countImageParts(content: unknown): number {
  if (!Array.isArray(content)) return 0;
  let count = 0;
  for (const part of content) {
    if (isImagePart(part)) count += 1;
  }
  return count;
}

/**
 * Read-image tool results duplicate the whole image as base64 JSON text in
 * every later prompt — the model already sees it as the injected image
 * message. Strip the payload from the prompt copy (persisted history keeps
 * it for scrollback/rehydration).
 */
export function elideImageToolResults(message: ModelMessage): ModelMessage {
  if (!Array.isArray(message.content)) return message;
  let changed = false;
  const parts = message.content.map((part) => {
    if (imageToolResultData(part) === undefined) return part;
    changed = true;
    const output = (part as { output: { value: Record<string, unknown> } }).output;
    return {
      ...part,
      output: { ...output, value: { ...output.value, data: IMAGE_ELISION_PLACEHOLDER } },
    };
  });
  return changed ? ({ ...message, content: parts } as ModelMessage) : message;
}

/**
 * Per-image cost when the pixel dimensions are unknown: sessions written before
 * dimensions were captured, and headers we cannot parse. Roughly what a
 * full-size image costs, so the error stays small and on the safe side.
 */
export const IMAGE_TOKEN_COST = 1_600;

/**
 * Pixel dimensions recorded on an image part when it was built, alongside the
 * `chimera.sourcePath` the prompt builder reads. Absent on parts from sessions
 * written before capture existed, and on images whose header we could not read.
 */
export function imageDimensions(part: unknown): ImageDimensions | undefined {
  const chimeraOptions = (part as { providerOptions?: { chimera?: Record<string, unknown> } })
    ?.providerOptions?.chimera;
  const width = chimeraOptions?.width;
  const height = chimeraOptions?.height;
  if (typeof width !== 'number' || typeof height !== 'number') return undefined;
  return { width, height };
}

/**
 * Tokens for one image, derived from the pixel count it will have after being
 * scaled to fit `longEdge`. The divisor is the industry-standard patch size;
 * scaling first is what keeps a 4K screenshot from costing 7x its real price.
 */
export function estimateImageTokens(dims: ImageDimensions | undefined, longEdge: number): number {
  if (!dims) return IMAGE_TOKEN_COST;
  const scale = Math.min(1, longEdge / Math.max(dims.width, dims.height));
  return Math.ceil((Math.round(dims.width * scale) * Math.round(dims.height * scale)) / 750);
}
