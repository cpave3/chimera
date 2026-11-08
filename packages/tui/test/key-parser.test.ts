import { describe, expect, it } from 'vitest';
import { type InputEvent, KeyParser } from '../src/terminal/keys';

/** A compact view of events: `a`, `enter`, `ctrl+c`, `shift+enter`, `paste:…`, `wheel-up@3,4`. */
function names(events: InputEvent[]): string[] {
  return events.map((event) => {
    if (event.type === 'paste') return `paste:${event.text}`;
    if (event.type === 'focus') return event.focused ? 'focus-in' : 'focus-out';
    if (event.type === 'mouse') return `${event.action}@${event.x},${event.y}`;
    const mods = [event.ctrl && 'ctrl', event.alt && 'alt', event.shift && 'shift'].filter(Boolean);
    return [...mods, event.name].join('+');
  });
}

function parse(...chunks: string[]): string[] {
  const parser = new KeyParser();
  return chunks.flatMap((chunk) => names(parser.feed(chunk)));
}

describe('KeyParser: legacy keys', () => {
  it('splits a burst into one event per key, in order', () => {
    expect(parse('hello\r')).toEqual(['h', 'e', 'l', 'l', 'o', 'enter']);
    expect(parse('ab\x1b[DX')).toEqual(['a', 'b', 'left', 'X']);
    expect(parse('\x7f\x7f\x7f')).toEqual(['backspace', 'backspace', 'backspace']);
  });

  it('gives printable keys their text, and keeps a typed newline apart from Enter', () => {
    const [key] = new KeyParser().feed('é');
    expect(key).toMatchObject({ type: 'key', name: 'é', text: 'é', ctrl: false });
    expect(parse('\n')).toEqual(['ctrl+enter']);
  });

  it('reads control keys and Alt+key', () => {
    expect(parse('\x03\x01\t\x1b[Z')).toEqual(['ctrl+c', 'ctrl+a', 'tab', 'shift+tab']);
    expect(parse('\x1bb\x1b\r\x1b\x7f')).toEqual(['alt+b', 'alt+enter', 'alt+backspace']);
  });

  it('reads arrows, paging, Home/End with modifiers, Delete and function keys', () => {
    expect(parse('\x1b[A\x1bOB\x1b[5~\x1b[6~\x1b[H\x1b[F\x1b[1~\x1b[4~')).toEqual([
      'up',
      'down',
      'pageup',
      'pagedown',
      'home',
      'end',
      'home',
      'end',
    ]);
    expect(parse('\x1b[1;5H\x1b[1;5F\x1b[1;2A\x1b[3~\x1bOP\x1b[15~\x1b[24~')).toEqual([
      'ctrl+home',
      'ctrl+end',
      'shift+up',
      'delete',
      'f1',
      'f5',
      'f12',
    ]);
  });

  it('holds a lone Esc until the parser is flushed, then reports it', () => {
    const parser = new KeyParser();
    expect(parser.feed('\x1b')).toEqual([]);
    expect(parser.pending).toBe(true);
    expect(names(parser.flush())).toEqual(['escape']);
    expect(parser.pending).toBe(false);
  });

  it('reassembles a sequence split across reads', () => {
    expect(parse('a\x1b', '[', 'A')).toEqual(['a', 'up']);
    expect(parse('\x1b[1;', '5H')).toEqual(['ctrl+home']);
  });

  it('drops a CSI sequence it does not know rather than typing it', () => {
    expect(parse('\x1b[?62;c', 'x')).toEqual(['x']);
  });
});

describe('KeyParser: Kitty keyboard protocol and modifyOtherKeys', () => {
  it('reads CSI u: Shift+Enter, Ctrl+letters, Alt+letters, Esc, Tab, Backspace', () => {
    expect(parse('\x1b[13;2u\x1b[99;5u\x1b[97;3u\x1b[27u\x1b[9;2u\x1b[127u\x1b[13u')).toEqual([
      'shift+enter',
      'ctrl+c',
      'alt+a',
      'escape',
      'shift+tab',
      'backspace',
      'enter',
    ]);
  });

  it('reads xterm modifyOtherKeys: Shift+Enter, Ctrl+letters, Alt+letters', () => {
    expect(parse('\x1b[27;2;13~\x1b[27;5;99~\x1b[27;3;97~\x1b[27;6;13~')).toEqual([
      'shift+enter',
      'ctrl+c',
      'alt+a',
      'ctrl+shift+enter',
    ]);
  });

  it('types the shifted character for a Shift-only printable key', () => {
    const [key] = new KeyParser().feed('\x1b[97:65;2u');
    expect(key).toMatchObject({ name: 'A', text: 'A', shift: true });
  });
});

describe('KeyParser: mouse and focus', () => {
  it('reads SGR wheel, press, drag and release, from one-based to zero-based cells', () => {
    expect(parse('\x1b[<64;3;4M\x1b[<65;3;4M\x1b[<0;10;2M\x1b[<32;12;2M\x1b[<0;12;2m')).toEqual([
      'wheel-up@2,3',
      'wheel-down@2,3',
      'press@9,1',
      'drag@11,1',
      'release@11,1',
    ]);
  });

  it('reports focus in and out', () => {
    expect(parse('\x1b[I\x1b[O')).toEqual(['focus-in', 'focus-out']);
  });

  it('keeps a mouse report split across reads whole', () => {
    expect(parse('\x1b[<64;3', ';4M')).toEqual(['wheel-up@2,3']);
  });
});

describe('KeyParser: bracketed paste', () => {
  it('delivers a paste as one event with LF line ends', () => {
    expect(parse('\x1b[200~a\rb\r\nc\nd\x1b[201~')).toEqual(['paste:a\nb\nc\nd']);
  });

  it('reassembles paste markers split across reads', () => {
    expect(parse('x\x1b[20', '0~one\r', '\ntwo\x1b[2', '01~y')).toEqual([
      'x',
      'paste:one\ntwo',
      'y',
    ]);
  });

  it('keeps escape-like bytes inside a paste as text', () => {
    expect(parse('\x1b[200~\x1b[A\x03\x1b[201~')).toEqual(['paste:\x1b[A\x03']);
  });
});
