// src/core/users.ts
//
// Zentrale Hilfsfunktionen für den Umgang mit "users" in Supabase.
// Ziel: Duplizierten Code in server.ts vermeiden und Lookup-Verhalten vereinheitlichen.

import { supabase } from '../../supabase_client';

export type DbUser = {
  id: string;
  username: string;
};

/**
 * Normalisiert einen einzelnen Identifier-String:
 * - trimmt Whitespace
 * - gibt bei leerem String null zurück
 */
export function normalizeUserString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Nimmt die drei möglichen Felder (user, userId, username) entgegen
 * und ermittelt daraus einen konsistenten Identifier-String.
 *
 * Reihenfolge:
 *   1. user
 *   2. userId
 *   3. username
 *
 * Falls alle leer/ungültig sind → null.
 */
export function resolveUserIdentifier(input: {
  user?: unknown;
  userId?: unknown;
  username?: unknown;
}): string | null {
  return (
    normalizeUserString(input.user) ??
    normalizeUserString(input.userId) ??
    normalizeUserString(input.username) ??
    null
  );
}

/**
 * Lädt einen Benutzer anhand des Usernamens.
 *
 * - trimmt den Namen
 * - wirft bei Supabase-Fehlern eine Exception
 * - gibt bei "nicht gefunden" null zurück
 */
export async function findUserByUsername(
  username: string,
): Promise<DbUser | null> {
  const trimmed = username.trim();
  if (!trimmed) {
    return null;
  }

  const { data, error } = await supabase
    .from('users')
    .select('id, username')
    .eq('username', trimmed)
    .maybeSingle();

  if (error) {
    console.error('[users] Fehler beim User-Lookup:', {
      username: trimmed,
      error,
    });
    throw error;
  }

  if (!data) {
    return null;
  }

  return {
    id: data.id as string,
    username: data.username as string,
  };
}

/**
 * Convenience-Helfer:
 *  - Nimmt { user, userId, username } entgegen
 *  - normalisiert den Identifier
 *  - führt dann den DB-Lookup aus
 */
export async function findUserFromPayload(input: {
  user?: unknown;
  userId?: unknown;
  username?: unknown;
}): Promise<DbUser | null> {
  const identifier = resolveUserIdentifier(input);
  if (!identifier) return null;
  return findUserByUsername(identifier);
}