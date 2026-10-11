export interface ActivityInput {
  /** A permission request is open; the run cannot move until it is answered. */
  awaitingApproval: boolean;
  /** The model asked the user a question and waits for the answer. */
  awaitingAnswer?: boolean;
  compacting: boolean;
  /** Set while the agent waits to resend a step after a provider error. */
  retry: { attempt: number; maxAttempts: number } | null;
  /** The most recent tool call that has not returned. */
  inFlightTool: { name: string; label?: string; summary: string } | null;
  /** Assistant or reasoning text is arriving. */
  streaming: boolean;
}

/**
 * One phrase for what the run is doing right now. The order is by what the
 * user most needs to know: something that needs them first, then what the
 * agent is blocked on, then what it is working on.
 */
export function describeActivity(input: ActivityInput): string {
  if (input.awaitingApproval) return 'waiting for approval';
  if (input.awaitingAnswer) return 'waiting for your answer';
  if (input.compacting) return 'compacting context';
  if (input.retry) {
    return `provider error, retry ${input.retry.attempt}/${input.retry.maxAttempts}`;
  }
  if (input.inFlightTool) {
    const { name, label, summary } = input.inFlightTool;
    return name === 'bash' ? `running ${summary}` : `${label ?? name} ${summary}`.trimEnd();
  }
  return input.streaming ? 'writing' : 'thinking';
}

export function formatElapsed(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
  const seconds = totalSeconds % 60;
  const minutes = Math.floor(totalSeconds / 60) % 60;
  const hours = Math.floor(totalSeconds / 3600);
  const pad = (value: number) => String(value).padStart(2, '0');
  if (hours > 0) return `${hours}h ${pad(minutes)}m`;
  if (minutes > 0) return `${minutes}m ${pad(seconds)}s`;
  return `${seconds}s`;
}
