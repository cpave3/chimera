/**
 * The text the model gets for a denied call, including policy diagnostics
 * or the reason supplied by the decision-maker.
 */
export function permissionDenialMessage(
  source:
    | 'rule'
    | 'hook'
    | 'mod'
    | 'headless'
    | 'policy'
    | 'reviewer'
    | 'system_one'
    | 'user'
    | undefined,
  reason?: string,
): string {
  if (source === 'rule') return 'denied by rule';
  if (source === 'hook') return 'denied by hook';
  if (source === 'mod') return reason ? `denied by mod: ${reason}` : 'denied by mod';
  if (source === 'headless' || source === 'policy') {
    return reason ? `denied by policy: ${reason}` : 'denied by policy';
  }
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
