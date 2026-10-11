import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/** Tiny persistence layer: one JSON snapshot per room plus an append-only event log. */
export class Store {
  private db: DatabaseSync;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS rooms (
        id TEXT PRIMARY KEY,
        updated_at INTEGER NOT NULL,
        json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS events (
        room_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        json TEXT NOT NULL,
        PRIMARY KEY (room_id, seq)
      );
    `);
  }

  saveRoom(id: string, json: string, updatedAt: number): void {
    this.db.prepare('INSERT OR REPLACE INTO rooms (id, updated_at, json) VALUES (?, ?, ?)').run(id, updatedAt, json);
  }

  appendEvent(roomId: string, seq: number, json: string): void {
    this.db.prepare('INSERT INTO events (room_id, seq, json) VALUES (?, ?, ?)').run(roomId, seq, json);
  }

  loadRooms(): { id: string; json: string; events: string[] }[] {
    const rooms = this.db.prepare('SELECT id, json FROM rooms').all() as { id: string; json: string }[];
    const stmt = this.db.prepare('SELECT json FROM events WHERE room_id = ? ORDER BY seq');
    return rooms.map((r) => ({
      id: r.id,
      json: r.json,
      events: (stmt.all(r.id) as { json: string }[]).map((e) => e.json),
    }));
  }

  deleteRoom(id: string): void {
    this.db.prepare('DELETE FROM events WHERE room_id = ?').run(id);
    this.db.prepare('DELETE FROM rooms WHERE id = ?').run(id);
  }

  close(): void {
    this.db.close();
  }
}
