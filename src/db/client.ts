import { Kysely, PostgresDialect, sql } from 'kysely';
import { Pool } from 'pg';
import { getEnv } from '../utils/env.ts';

// Detect runtime and conditionally import Deno postgres driver
const isDeno = typeof Deno !== 'undefined';
let DenoPool: any = null;

if (isDeno) {
  try {
    const mod = await import('postgres');
    DenoPool = mod.Pool;
  } catch (e) {
    console.warn('Failed to load Deno postgres driver, falling back to pg:', e);
  }
}

let db: Kysely<any> | null = null;

/**
 * Get or create the Kysely database instance
 * This allows for easy switching between different PostgreSQL providers (Supabase, Neon, etc.)
 * by simply changing the DATABASE_URL environment variable
 */
export function getDatabase(): Kysely<any> {
  if (!db) {
    const databaseUrl = getEnv('DATABASE_URL') || getEnv('SUPABASE_DB_URL');
    
    if (!databaseUrl) {
      throw new Error('DATABASE_URL or SUPABASE_DB_URL environment variable is not set');
    }

    if (isDeno && DenoPool) {
      // Use Deno native driver (avoids readFileSync warning)
      const dialect = new PostgresDialect({
        pool: new DenoPool(databaseUrl, 10) as any
      });
      db = new Kysely<any>({ dialect });
    } else {
      // Use Node.js pg driver for other environments (Cloudflare, etc.)
      const dialect = new PostgresDialect({
        pool: new Pool({
          connectionString: databaseUrl,
          max: 10,
        })
      });
      db = new Kysely<any>({ dialect });
    }
  }

  return db;
}

/**
 * Close the database connection
 * Call this when shutting down the application
 */
export async function closeDatabase(): Promise<void> {
  if (db) {
    await db.destroy();
    db = null;
  }
}

// Export sql template literal for safe SQL queries
export { sql };
