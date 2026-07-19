import type { ModelMessage } from 'ai';
import {
  DEFAULT_IMAGE_LONG_EDGE,
  elideImageToolResults,
  estimateImageTokens,
  imageDimensions,
  isImagePart,
} from './message-parts';

/** Fixed per-message overhead constant to account for role/formatting tokens. */
export const PER_MESSAGE_OVERHEAD = 16;

export interface EstimateOptions {
  /** Long-edge pixel limit images are scaled to fit; defaults to DEFAULT_IMAGE_LONG_EDGE. */
  imageLongEdge?: number;
}

/**
 * Conservative char/4 heuristic for token estimation. Each message
 * contributes JSON-stringified length / 4 rounded up, plus a small overhead
 * constant. (Moved here from @chimera/compaction, which re-exports it.)
 *
 * Images are charged by pixel count rather than by payload length — see
 * `measurableText`.
 */
export function estimateTokens(messages: ModelMessage[], opts?: EstimateOptions): number {
  const longEdge = opts?.imageLongEdge ?? DEFAULT_IMAGE_LONG_EDGE;
  let total = 0;
  for (const message of messages) {
    total += Math.ceil(measurableText(message).length / 4) + PER_MESSAGE_OVERHEAD;
    if (!Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (isImagePart(part)) total += estimateImageTokens(imageDimensions(part), longEdge);
    }
  }
  return total;
}

/**
 * The estimator has to model what `prepareMessagesForModel` sends, not the raw
 * session history: image payloads reach the provider as image tokens rather
 * than base64 characters, and read-image tool results are elided from the
 * prompt entirely. Measuring the history verbatim charged a 512KB screenshot
 * ~175k tokens against a real cost near 1.6k, which tripped compaction on
 * sight and then discarded the very images that tripped it.
 *
 * Blanking `image` rather than dropping the part keeps key order intact, so
 * the JSON of image-free content is byte-identical to measuring it directly.
 */
function measurableText(message: ModelMessage): string {
  if (typeof message.content === 'string') return message.content;
  const elided = elideImageToolResults(message);
  if (!Array.isArray(elided.content)) return JSON.stringify(elided.content);
  return JSON.stringify(
    elided.content.map((part) => (isImagePart(part) ? { ...part, image: '' } : part)),
  );
}

/**
 * Tracks what the provider actually charged for the last prompt so compaction
 * decisions run on real numbers instead of the char/4 heuristic alone.
 *
 * Fresh mode: `projectedNextPrompt` = last reported `inputTokens` plus the
 * char/4 estimate of messages appended since that prompt was sent — the
 * heuristic only covers the delta, so its error stays small. Stale mode
 * (before the first usage report, after `noteCompaction()` rewrote history,
 * or when the message array shrank underneath us): pure estimate over
 * everything, exactly the pre-tracker behavior. Providers that never report
 * usage simply stay in stale mode.
 */
export class ContextTracker {
  private lastInputTokens: number | null = null;
  private messageCountAtPrompt = 0;

  /** Record a finish-step usage report: the prompt of that step contained `messageCountAtPrompt` messages. */
  noteUsage(inputTokens: number, messageCountAtPrompt: number): void {
    this.lastInputTokens = inputTokens;
    this.messageCountAtPrompt = messageCountAtPrompt;
  }

  /** History was rewritten (compaction); the last usage no longer describes it. */
  noteCompaction(): void {
    this.lastInputTokens = null;
    this.messageCountAtPrompt = 0;
  }

  projectedNextPrompt(messages: ModelMessage[], opts?: EstimateOptions): number {
    if (this.lastInputTokens === null || messages.length < this.messageCountAtPrompt) {
      return estimateTokens(messages, opts);
    }
    return this.lastInputTokens + estimateTokens(messages.slice(this.messageCountAtPrompt), opts);
  }
}

const DEFAULT_MAX_OUTPUT_TOKENS = 8_192;
const GROWTH_MARGIN_TOKENS = 4_096;

export interface ShouldCompactInput {
  projected: number;
  contextWindow: number;
  /** Compact when the projected prompt crosses this percentage of the window. */
  thresholdPercent: number;
  /** Absolute floor reserved below the window. */
  reserveTokens: number;
  /** The session model's output budget; the reserve must cover it. */
  maxOutputTokens?: number;
}

/**
 * Trigger = min(window * pct, window - reserve), where the reserve is at
 * least the model's output budget plus a growth margin for tool results that
 * land before the next check.
 */
export function shouldCompact(input: ShouldCompactInput): boolean {
  // Clamp the reserve to half the window so a small window with a large
  // output budget degrades to "compact early", not "compact always".
  const reserve = Math.min(
    Math.max(
      input.reserveTokens,
      (input.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS) + GROWTH_MARGIN_TOKENS,
    ),
    input.contextWindow / 2,
  );
  const limit = Math.min(
    (input.contextWindow * input.thresholdPercent) / 100,
    input.contextWindow - reserve,
  );
  return input.projected > limit;
}
