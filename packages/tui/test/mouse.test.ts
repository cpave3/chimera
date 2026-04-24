import { describe, expect, it } from 'vitest';
import { parseMouseChunk } from '../src/mouse';

describe('parseMouseChunk', () => {
  it('passes through normal input unchanged', () => {
    const r = parseMouseChunk('hello world');
    expect(r).toEqual({ cleaned: 'hello world', wheels: [] });
  });

  it('extracts a wheel-up event (button 64, press)', () => {
    const r = parseMouseChunk('\x1b[<64;10;5M');
    expect(r.cleaned).toBe('');
    expect(r.wheels).toEqual(['up']);
  });

  it('extracts a wheel-down event (button 65, press)', () => {
    const r = parseMouseChunk('\x1b[<65;10;5M');
    expect(r.wheels).toEqual(['down']);
  });

  it('ignores non-wheel mouse events', () => {
    // Button 0 = left click, Button 35 = motion (no-button drag). Should
    // produce no wheel events.
    const r = parseMouseChunk('\x1b[<0;10;5M\x1b[<35;11;5M');
    expect(r.wheels).toEqual([]);
    expect(r.cleaned).toBe('');
  });

  it('ignores wheel release events (m terminator)', () => {
    const r = parseMouseChunk('\x1b[<64;10;5m');
    expect(r.wheels).toEqual([]);
  });

  it('strips mouse sequences but keeps surrounding input', () => {
    // User presses "a", scrolls wheel up, types "b".
    const r = parseMouseChunk('a\x1b[<64;10;5Mb');
    expect(r.cleaned).toBe('ab');
    expect(r.wheels).toEqual(['up']);
  });

  it('handles multiple wheel events in one chunk', () => {
    const r = parseMouseChunk('\x1b[<64;1;1M\x1b[<64;1;1M\x1b[<65;1;1M');
    expect(r.wheels).toEqual(['up', 'up', 'down']);
  });

  it('masks modifier bits so shift+wheel still registers', () => {
    // SGR button 68 = wheel-up with the shift modifier (64 | 4).
    const r = parseMouseChunk('\x1b[<68;1;1M');
    expect(r.wheels).toEqual(['up']);
  });

  it('tolerates a truncated sequence at end of chunk', () => {
    // Incomplete: `\x1b[<64;1` with no terminator. We pass it through rather
    // than eating bytes that might complete in a later chunk. Simpler than
    // buffering for MVP — ink will see garbage momentarily at worst.
    const r = parseMouseChunk('a\x1b[<64;1');
    expect(r.wheels).toEqual([]);
    expect(r.cleaned).toBe('a\x1b[<64;1');
  });
});
