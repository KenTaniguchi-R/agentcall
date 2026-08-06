import type { RoomPublicParticipantType } from "@benree/agentcall-shared";

/**
 * In-Room addressing: a display name, and nothing else (#347).
 *
 * A Room fixes by context everything a durable address carries — the relay
 * (the only one this Room lives on), the organization (none; a Room has no
 * Team), and the Room itself (the one this process is in). That leaves *which
 * person*, which the display name already answers uniquely: the relay rejects
 * a duplicate name at join, comparing NFC + lowercase.
 *
 * Matching uses that same key, so a name that the relay considered a
 * duplicate is a name this resolver considers a match. Anything else would
 * let two participants exist that this module cannot tell apart.
 */

const ROOM_NAME_KEY = (value: string): string => value.normalize("NFC").toLowerCase();

export type RoomResolution =
  | { kind: "ok"; participant: RoomPublicParticipantType }
  | { kind: "address" }
  | { kind: "unknown"; typed: string }
  | { kind: "ambiguous"; typed: string; matches: readonly RoomPublicParticipantType[] }
  | { kind: "self" };

export interface ResolveRoomNameOptions {
  typed: string;
  participants: readonly RoomPublicParticipantType[];
  ownParticipantId: string;
}

export function resolveRoomName(options: ResolveRoomNameOptions): RoomResolution {
  const typed = options.typed.trim();

  // `formatAddress` is `@${org}/${handle}`, so every durable address begins
  // with `@` and no display name may contain one (`RoomDisplayName`). Someone
  // typing `@acme/sota` in a Room means the durable path, which a Room has no
  // way to reach — say so rather than reporting "no such person".
  if (typed.startsWith("@")) return { kind: "address" };

  const key = ROOM_NAME_KEY(typed);
  const matches = options.participants.filter((p) => ROOM_NAME_KEY(p.display_name) === key);

  if (matches.length === 0) return { kind: "unknown", typed };
  // The relay's join-time uniqueness check makes this unreachable. It is
  // handled anyway because the alternative — picking matches[0] — would
  // silently send a private question to whichever of two identically-named
  // participants happened to sort first.
  if (matches.length > 1) return { kind: "ambiguous", typed, matches };
  if (matches[0]!.participant_id === options.ownParticipantId) return { kind: "self" };
  return { kind: "ok", participant: matches[0]! };
}

/**
 * A best-effort homoglyph skeleton, used only to *warn*, never to match.
 *
 * The relay compares names under NFC + lowercase, so `Ken` and `Kеn` (U+0435
 * Cyrillic small ie) are distinct and both admissible. Resolution handles that
 * correctly — typing Latin `Ken` reaches the Latin participant. The hazard is
 * the human one: two rows in the roster that look identical, where the reader
 * cannot tell which is which.
 *
 * This covers the Cyrillic and Greek letters that render as Latin lowercase in
 * common terminal fonts. It is not the full Unicode confusables table and does
 * not try to be — a partial table that flags the realistic attack is worth
 * more than none, and a missed pair costs a warning, not a misrouted call.
 */
const HOMOGLYPHS = new Map<string, string>(Object.entries({
  "а": "a", "е": "e", "о": "o", "р": "p", "с": "c",
  "х": "x", "у": "y", "і": "i", "ј": "j", "һ": "h",
  "ѕ": "s", "к": "k", "м": "m", "т": "t", "в": "b",
  "α": "a", "ο": "o", "ρ": "p", "υ": "u", "ν": "v",
  "κ": "k", "χ": "x", "ι": "i", "τ": "t",
}));

export function confusableSkeleton(name: string): string {
  return [...ROOM_NAME_KEY(name)].map((ch) => HOMOGLYPHS.get(ch) ?? ch).join("");
}

/** Participant IDs whose display name looks like another participant's. */
export function confusableParticipantIds(
  participants: readonly RoomPublicParticipantType[],
): ReadonlySet<string> {
  const bySkeleton = new Map<string, RoomPublicParticipantType[]>();
  for (const participant of participants) {
    const skeleton = confusableSkeleton(participant.display_name);
    const bucket = bySkeleton.get(skeleton);
    if (bucket) bucket.push(participant);
    else bySkeleton.set(skeleton, [participant]);
  }
  const flagged = new Set<string>();
  for (const bucket of bySkeleton.values()) {
    if (bucket.length > 1) for (const participant of bucket) flagged.add(participant.participant_id);
  }
  return flagged;
}
