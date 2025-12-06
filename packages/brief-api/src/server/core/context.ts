// packages/brief-api/src/server/core/context.ts
//
// Hilfsfunktionen rund um Interview-Kontexte,
// damit server.ts schlanker und wiederverwendbarer wird.

import {
  loadActiveInterviewForUser,
  loadLeanContext,
  type InterviewRow,
  type LeanInterviewContext,
} from './interviews';
import { findUserByUsername, type DbUser } from './users';

export interface UserInterviewContextResult {
  user: DbUser;
  interview: InterviewRow;
  context: LeanInterviewContext;
}

/**
 * Lädt für einen gegebenen Benutzer-Namen:
 *   - den User-Datensatz
 *   - das aktuellste aktive Interview
 *   - den Lean-Interview-Kontext
 *
 * Rückgabe:
 *   - null, wenn User nicht existiert oder kein aktives Interview vorliegt
 *   - sonst alle drei Objekte in einem Paket
 *
 * Fehler von Supabase werden durchgereicht (wie in den bestehenden Helpern).
 */
export async function loadContextForUserIdentifier(
  username: string,
): Promise<UserInterviewContextResult | null> {
  const trimmed = username.trim();
  if (!trimmed) return null;

  const user = await findUserByUsername(trimmed);
  if (!user) {
    return null;
  }

  const interview = await loadActiveInterviewForUser(user.id);
  if (!interview) {
    return null;
  }

  const context = await loadLeanContext(interview.id);

  return {
    user,
    interview,
    context,
  };
}

/**
 * Thin-Wrapper für "Lean Context per Interview-ID".
 * Aktuell nur ein Alias auf loadLeanContext, sorgt aber
 * für einen klaren Einstiegspunkt aus server.ts.
 */
export async function loadContextForInterviewId(
  interviewId: string,
): Promise<LeanInterviewContext> {
  return loadLeanContext(interviewId);
}