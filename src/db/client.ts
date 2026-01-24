import { Kysely, PostgresDialect, sql } from 'kysely';
import { Pool } from 'pg';
import { getEnv } from '../utils/env.ts';

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

    const dialect = new PostgresDialect({
      pool: new Pool({
        connectionString: databaseUrl,
        // Connection pool settings - adjust based on your provider
        max: 10,
      })
    });

    db = new Kysely<any>({
      dialect,
    });
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
