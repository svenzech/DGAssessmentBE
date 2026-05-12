import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'url';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import {
  createSqlCompatClientForAzureSql,
  createSqlCompatClientForPostgres,
} from './sql_compat';

export type DbProvider = 'supabase' | 'azure_postgres' | 'azure_sql';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PACKAGE_ROOT = path.resolve(__dirname, '..', '..');
const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..');

dotenv.config({ path: path.join(PROJECT_ROOT, '.env') });
dotenv.config({ path: path.join(PACKAGE_ROOT, '.env') });

const provider = (process.env.DB_PROVIDER?.trim().toLowerCase() ||
  'supabase') as DbProvider;

function getSafeUrlDescription(value: string): string {
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.hostname}`;
  } catch {
    return value.includes('://') ? '<invalid URL>' : value;
  }
}

function assertHttpUrl(name: string, value: string): void {
  let url: URL;

  try {
    url = new URL(value);
  } catch {
    throw new Error(
      `${name} must be an HTTP URL, got ${getSafeUrlDescription(value)}`,
    );
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error(
      `${name} must use http(s), got ${getSafeUrlDescription(value)}`,
    );
  }
}

function createSupabaseClientFromEnv(): SupabaseClient {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !supabaseServiceRoleKey) {
    console.error('Missing env vars: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY');
    throw new Error('SUPABASE env vars missing in db/provider.ts');
  }

  assertHttpUrl('SUPABASE_URL', supabaseUrl);
  console.info(
    'Database provider configured: supabase',
    getSafeUrlDescription(supabaseUrl),
  );

  return createClient(supabaseUrl, supabaseServiceRoleKey, {
    auth: { persistSession: false },
  });
}

function assertAzurePostgresEnv() {
  const connectionString = process.env.POSTGRES_CONNECTION_STRING;

  if (!connectionString) {
    throw new Error(
      'POSTGRES_CONNECTION_STRING must be set when DB_PROVIDER=azure_postgres',
    );
  }

  console.info(
    'Database provider configured: azure_postgres',
    getSafeUrlDescription(connectionString),
  );
}

function assertAzureSqlEnv() {
  const connectionString = process.env.AZURE_SQL_CONNECTION_STRING;

  if (!connectionString) {
    throw new Error(
      'AZURE_SQL_CONNECTION_STRING must be set when DB_PROVIDER=azure_sql',
    );
  }

  console.info('Database provider configured: azure_sql');
}

export function createDbClient(): any {
  if (provider === 'supabase') {
    return createSupabaseClientFromEnv();
  }

  if (provider === 'azure_postgres') {
    assertAzurePostgresEnv();
    return createSqlCompatClientForPostgres(process.env.POSTGRES_CONNECTION_STRING!);
  }

  if (provider === 'azure_sql') {
    assertAzureSqlEnv();
    return createSqlCompatClientForAzureSql(process.env.AZURE_SQL_CONNECTION_STRING!);
  }

  throw new Error(
    `Unsupported DB_PROVIDER="${provider}". Supported values: supabase, azure_postgres, azure_sql`,
  );
}

export const dbProvider = provider;
export const db: any = createDbClient();
