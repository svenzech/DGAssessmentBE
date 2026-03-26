// packages/brief-api/src/supabase_client.ts
// Compatibility layer: existing call sites import `supabase`; runtime comes from db provider.

import { db, dbProvider } from './db/provider';

export const supabase = db;
export { dbProvider };
