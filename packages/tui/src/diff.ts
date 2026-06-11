export type DiffEntry = { kind: 'same' | 'del' | 'add'; line: string };

export function lineDiff(oldLines: string[], newLines: string[]): DiffEntry[] {
  const oldLen = oldLines.length;
  const newLen = newLines.length;

  const lcsLengths: number[][] = Array.from({ length: oldLen + 1 }, () =>
    new Array(newLen + 1).fill(0),
  );
  for (let i = oldLen - 1; i >= 0; i--) {
    for (let j = newLen - 1; j >= 0; j--) {
      if (oldLines[i] === newLines[j]) {
        lcsLengths[i]![j] = lcsLengths[i + 1]![j + 1]! + 1;
      } else {
        lcsLengths[i]![j] = Math.max(lcsLengths[i + 1]![j]!, lcsLengths[i]![j + 1]!);
      }
    }
  }

  const out: DiffEntry[] = [];
  let i = 0;
  let j = 0;
  while (i < oldLen && j < newLen) {
    if (oldLines[i] === newLines[j]) {
      out.push({ kind: 'same', line: oldLines[i]! });
      i += 1;
      j += 1;
    } else if (lcsLengths[i + 1]![j]! >= lcsLengths[i]![j + 1]!) {
      out.push({ kind: 'del', line: oldLines[i]! });
      i += 1;
    } else {
      out.push({ kind: 'add', line: newLines[j]! });
      j += 1;
    }
  }
  while (i < oldLen) {
    out.push({ kind: 'del', line: oldLines[i]! });
    i += 1;
  }
  while (j < newLen) {
    out.push({ kind: 'add', line: newLines[j]! });
    j += 1;
  }
  return out;
}
