import build from '../builtin/build.md';
import plan from '../builtin/plan.md';

/** The shipped modes, by file name. */
export const BUILTIN_MODES: Record<string, string> = { 'build.md': build, 'plan.md': plan };
