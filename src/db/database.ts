import Database from 'better-sqlite3';
import { join } from 'node:path';
import { getSolDir, ensureSolDir } from '../core/config-manager.js';
import { migration001 } from './migrations/001_initial.js';
import { migration002 } from './migrations/002_tx_prices.js';
import { migration003 } from './migrations/003_token_lists.js';
import { migration004 } from './migrations/004_predictions.js';

const DB_PATH = join(getSolDir(), 'data.db');

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (!db) {
    ensureSolDir();
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
  }
  return db;
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}

interface MigrationRecord {
  id: number;
  name: string;
  sql: string;
}

const migrations: MigrationRecord[] = [
  { id: 1, name: '001_initial', sql: migration001 },
  { id: 2, name: '002_tx_prices', sql: migration002 },
  { id: 3, name: '003_token_lists', sql: migration003 },
  { id: 4, name: '004_predictions', sql: migration004 },
];

function runMigrations(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  const applied = new Set(
    database.prepare('SELECT id FROM _migrations').all().map((r: any) => r.id)
  );

  for (const migration of migrations) {
    if (!applied.has(migration.id)) {
      database.exec(migration.sql);
      database.prepare('INSERT INTO _migrations (id, name) VALUES (?, ?)').run(
        migration.id, migration.name
      );
    }
  }
}
