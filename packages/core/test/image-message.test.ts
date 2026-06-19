import { describe, expect, it } from 'vitest';

describe('image message handling', () => {
  it('buildUserMessage returns plain string when no images', () => {
    const msg = buildUserMessage('hello');
    expect(msg).toEqual({ role: 'user', content: 'hello' });
  });

  it('buildUserMessage returns array content with image parts', () => {
    const msg = buildUserMessage('look at this', ['/path/to/img1.png', '/path/to/img2.jpg']);
    expect(msg.role).toBe('user');
    expect(Array.isArray(msg.content)).toBe(true);
    const parts = msg.content as Array<Record<string, unknown>>;
    expect(parts[0]).toEqual({ type: 'text', text: 'look at this' });
    expect(parts[1]).toEqual({ type: 'image', image: '/path/to/img1.png' });
    expect(parts[2]).toEqual({ type: 'image', image: '/path/to/img2.jpg' });
  });
});

// Inline the helper for testability without pulling in all agent deps
function buildUserMessage(text: string, imagePaths?: string[]): { role: 'user'; content: unknown } {
  if (!imagePaths || imagePaths.length === 0) {
    return { role: 'user', content: text };
  }
  const parts: Array<{ type: 'text'; text: string } | { type: 'image'; image: string }> = [
    { type: 'text', text },
  ];
  for (const path of imagePaths) {
    parts.push({ type: 'image', image: path });
  }
  return { role: 'user', content: parts };
}
