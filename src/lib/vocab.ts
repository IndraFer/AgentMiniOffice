/**
 * Closed vocabularies. Anything outside these sets is rejected, because an office whose
 * rooms can be named by the agent stops meaning anything within a week.
 */

import actionSchema from '../../public/schemas/action-v1.json' with {type:'json'};

import display from '../../public/schemas/display-v1.json' with {type:'json'};
const choices = display.$defs.options;
export function waitOptions(value:unknown): value is string[] {
  return Array.isArray(value) && value.length >= choices.minItems && value.length <= choices.maxItems &&
    value.every(v=>choices.items.enum.includes(v)) && new Set(value).size === value.length;
}
export const ROOMS = [
  "lobby",
  "barber",
  "desk",
  "whiteboard",
  "library",
  "workshop",
  "print-room",
  "phone-booth",
  "meeting",
  "pantry",
  "intern-desk",
  "away",
] as const;

export type Room = (typeof ROOMS)[number];

const ROOM_SET: ReadonlySet<string> = new Set(ROOMS);

export function isRoom(value: unknown): value is Room {
  return typeof value === "string" && ROOM_SET.has(value);
}

export const EVENT_TYPES = [
  "agent.registered",
  "agent.shutdown",
  "run.started",
  "run.finished",
  "run.failed",
  "plan.start",
  "plan.end",
  "tool.start",
  "tool.end",
  "tool.call",
  "spawn.started",
  "spawn.finished",
  "human.waiting",
  "human.resumed",
  "error",
  "note",
  "task.claimed",
  "task.acked",
  "task.expired",
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

const EVENT_TYPE_SET: ReadonlySet<string> = new Set(EVENT_TYPES);

export function isEventType(value: unknown): value is EventType {
  return typeof value === "string" && EVENT_TYPE_SET.has(value);
}

/** Event types a client is allowed to send. task.* belongs to the server. */
const SERVER_ONLY_TYPES: ReadonlySet<string> = new Set([
  "task.claimed",
  "task.acked",
  "task.expired",
]);

export function isClientEventType(value: unknown): value is EventType {
  return isEventType(value) && !SERVER_ONLY_TYPES.has(value);
}

const actionIdPattern = new RegExp(actionSchema.pattern);
export function validActionId(v:unknown): v is string {
  return typeof v === 'string' && v.length <= actionSchema.maxLength && actionIdPattern.test(v);
}
export function standardAction(v:unknown) {
  if (!validActionId(v)) return undefined;
  const catalog = actionSchema['x-actions'];
  return Object.hasOwn(catalog,v) ? v as keyof typeof catalog : 'other';
}
export function validVariant(action:unknown, variant:unknown): variant is string {
  const id=standardAction(action);
  if (!id || id!==action || !validActionId(variant)) return false;
  const entry=actionSchema['x-actions'][id];
  return 'variants' in entry && entry.variants.some(v=>v.id===variant);
}
export function actionRoom(action: NonNullable<ReturnType<typeof standardAction>>): Room | null {
  const room = actionSchema['x-actions'][action].room;
  return isRoom(room) ? room : null;
}

// Engine-neutral compatibility only. Do not parse commands or register plugin names here.
const COMMON_TOOLS = {
  bash:'use_tools', powershell:'use_tools', shell:'use_tools', grep:'search_content', rg:'search_content',
  ls:'lookup_file', find:'lookup_file', glob:'lookup_file', read:'read', edit:'write', write:'write',
} as const;
export function eventAction(type:string, data:Record<string,unknown>, room:unknown) {
  if (type !== 'tool.start' && type !== 'tool.call') return type === 'note' ? standardAction(data.action) : undefined;
  if (data.action !== undefined) return standardAction(data.action);
  if (room != null) return undefined;
  const name = typeof data.tool === 'string' ? data.tool.toLowerCase() : '';
  return Object.hasOwn(COMMON_TOOLS,name) ? COMMON_TOOLS[name as keyof typeof COMMON_TOOLS] : 'other';
}

/**
 * Room proposed by an event, or null when the event should not move the avatar.
 *
 * `error` deliberately returns null: the avatar stays where it is and the desk lights up.
 * Moving the character on error hides the bug.
 */
export function roomForEvent(type: string, data: Record<string, unknown>): Room | null {
  switch (type) {
    case "agent.registered":
      return "barber";
    case "agent.shutdown":
      return "pantry";
    case "run.started":
      return "desk";
    case "run.finished":
    case "run.failed":
      return "pantry";
    case "plan.start": {
      const kind = typeof data.kind === "string" ? data.kind : "";
      return kind === "read" || kind === "research" ? "library" : "whiteboard";
    }
    case "plan.end":
      return "desk";
    case "tool.end":
      return null;
    case "spawn.started":
      return "phone-booth";
    case "spawn.finished":
      return "desk";
    case "human.waiting":
      return "meeting";
    case "human.resumed":
      return "desk";
    case "task.claimed":
      return "desk";
    case "task.acked":
      return "pantry";
    case "error":
    case "note":
    case "task.expired":
      return null;
    default:
      return null;
  }
}

export type PresenceState = "lobby" | "online" | "stale" | "offline";

/** Presence is inferred, never reported. An agent that crashed cannot tell you it is gone. */
export function presenceState(
  lastSeenMs: number | null,
  now: number,
  onlineMs: number,
  staleMs: number,
): PresenceState {
  if (lastSeenMs === null) return "lobby";
  const delta = now - lastSeenMs;
  if (delta < onlineMs) return "online";
  if (delta < staleMs) return "stale";
  return "offline";
}
