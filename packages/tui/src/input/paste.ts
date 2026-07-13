const MIN_COMPACT_PASTE_LINES = 5;
const MIN_COMPACT_PASTE_CHARACTERS = 1_000;

export function countPasteLines(text: string): number {
  return text.split('\n').length;
}

export function shouldCompactPaste(text: string): boolean {
  return (
    text.length >= MIN_COMPACT_PASTE_CHARACTERS || countPasteLines(text) >= MIN_COMPACT_PASTE_LINES
  );
}

export class PasteRegistry {
  private readonly entries = new Map<string, string>();
  private nextId = 1;

  register(text: string): string {
    const label = `[Pasted text #${this.nextId}, ${countPasteLines(text)} lines]`;
    this.nextId += 1;
    this.entries.set(label, text);
    return label;
  }

  expand(text: string): string {
    let expanded = text;
    for (const [label, content] of this.entries) {
      expanded = expanded.replaceAll(label, content);
    }
    return expanded;
  }

  clear(): void {
    this.entries.clear();
    this.nextId = 1;
  }
}
