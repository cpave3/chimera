export function permissionDenialMessage(
  source: 'rule' | 'hook' | 'headless' | 'policy' | 'user' | undefined,
): string {
  if (source === 'rule') return 'denied by rule';
  if (source === 'hook') return 'denied by hook';
  if (source === 'headless' || source === 'policy') return 'denied by policy';
  return 'denied by user';
}
