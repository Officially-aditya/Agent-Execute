import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { nowIso } from '@vac/shared';

export type AuditEvent = {
  id: string;
  type: string;
  at: string;
  data: Record<string, unknown>;
};

export function appendAudit(db: Database.Database, type: string, data: Record<string, unknown>): AuditEvent {
  const event: AuditEvent = { id: randomUUID(), type, at: nowIso(), data };
  db.prepare('INSERT INTO audit_events (id, type, at, data_json) VALUES (?, ?, ?, ?)')
    .run(event.id, event.type, event.at, JSON.stringify(event.data));
  return event;
}

export function listAudit(db: Database.Database, limit = 200): AuditEvent[] {
  return db.prepare('SELECT id, type, at, data_json FROM audit_events ORDER BY rowid DESC LIMIT ?')
    .all(limit)
    .map((row: any) => ({ id: row.id, type: row.type, at: row.at, data: JSON.parse(row.data_json) }));
}
