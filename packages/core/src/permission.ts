export function permissionDenialMessage(
  source: 'rule' | 'hook' | 'headless' | 'user' | undefined,
): string {
  if (source === 'rule') return 'denied by rule';
  if (source === 'hook') return 'denied by hook';
  if (source === 'headless') return 'denied by policy';
  return 'denied by user';
}
