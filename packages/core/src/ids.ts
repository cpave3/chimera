import { ulid } from 'ulid';

export type SessionId = string;
export type EventId = string;
export type CallId = string;

export function newSessionId(): SessionId {
  return ulid();
}

export function newEventId(): EventId {
  return ulid();
}

export function newCallId(): CallId {
  return ulid();
}

export function newRequestId(): string {
  return ulid();
}
