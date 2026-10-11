import { homedir } from 'node:os';

/** `~` for the home directory; a path longer than `max` keeps its last segments. */
export function displayPath(path: string, max: number): string {
  const home = homedir();
  const short = path === home || path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
  return short.length > max ? `…${short.slice(short.length - max + 1)}` : short;
}
