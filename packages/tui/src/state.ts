/** A state update: a new value, or a function of the current one. */
export type Setter<T> = (next: T | ((current: T) => T)) => void;

/** A value that handlers read and write directly. */
export interface Ref<T> {
  current: T;
}
