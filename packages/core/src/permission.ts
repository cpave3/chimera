export function permissionDenialMessage(
  source: 'rule' | 'hook' | 'headless' | 'policy' | 'reviewer' | 'user' | undefined,
  reviewerReason?: string,
): string {
  if (source === 'rule') return 'denied by rule';
  if (source === 'hook') return 'denied by hook';
  if (source === 'headless' || source === 'policy') return 'denied by policy';
  if (source === 'reviewer') {
    // The reviewer wanted the user to decide, and this session has nobody to ask.
    return `denied by reviewer: ${reviewerReason ?? 'the request needs the user'}`;
  }
  return 'denied by user';
}
