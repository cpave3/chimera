/**
 * The text the model gets for a denied call. `reason` is the reviewer's
 * reason or the System One check's note, for a denial that one of them made.
 */
export function permissionDenialMessage(
  source: 'rule' | 'hook' | 'headless' | 'policy' | 'reviewer' | 'system_one' | 'user' | undefined,
  reason?: string,
): string {
  if (source === 'rule') return 'denied by rule';
  if (source === 'hook') return 'denied by hook';
  if (source === 'headless' || source === 'policy') return 'denied by policy';
  if (source === 'reviewer') {
    // The reviewer wanted the user to decide, and this session has nobody to ask.
    return `denied by reviewer: ${reason ?? 'the request needs the user'}`;
  }
  if (source === 'system_one') {
    // The check rejected the command, and this session has nobody to ask.
    return `denied: System One ${reason ?? 'rejected the command'}`;
  }
  return 'denied by user';
}
