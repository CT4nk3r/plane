/**
 * User mapping — Plane's native `data.users` idiom (shared by the GitHub and
 * Jira importers): each entry is `{ username, import: "map"|"invite"|false, email }`.
 *
 * - "map": match an existing Plane member by email -> use their id as assignee.
 * - "invite": reserved for a future invite flow; treated as skip in v1.
 * - false: explicitly skip this user.
 *
 * When no entry matches a user, we default to auto-matching by email (assign if
 * a Plane member with that email exists, otherwise skip).
 */

import type { ExternalUserRef, PlaneMember, UserMapEntry } from "../types";

const EMAIL_RE = /[^\s<>]+@[^\s<>]+/;

/** Best-effort extraction of an email address from an ADO user reference. */
export function extractEmail(user: ExternalUserRef | null | undefined): string | undefined {
  if (!user) return undefined;
  const candidates = [user.uniqueName, user.mail, user.displayName];
  for (const candidate of candidates) {
    if (typeof candidate === "string") {
      const match = candidate.match(EMAIL_RE);
      if (match) return match[0].toLowerCase();
    }
  }
  return undefined;
}

function findMemberByEmail(email: string, members: PlaneMember[]): PlaneMember | undefined {
  const lowered = email.toLowerCase();
  return members.find((m) => typeof m.email === "string" && m.email.toLowerCase() === lowered);
}

/**
 * Resolve an ADO assignee to a Plane member id, or null if it should be skipped.
 */
export function resolveAssigneeId(
  assignee: ExternalUserRef | null | undefined,
  userMap: UserMapEntry[],
  members: PlaneMember[],
): string | null {
  const email = extractEmail(assignee);
  if (!email) return null;

  const entry = userMap.find(
    (e) =>
      (typeof e.email === "string" && e.email.toLowerCase() === email) ||
      (typeof e.username === "string" && e.username.toLowerCase() === email),
  );

  let targetEmail = email;
  if (entry) {
    if (entry.import === false) return null;
    if (entry.import === "invite") return null; // not supported in v1
    if (entry.email) targetEmail = entry.email.toLowerCase();
  }

  const member = findMemberByEmail(targetEmail, members);
  return member ? member.id : null;
}
