import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { reportValidator, type PreviewReport } from '@fsa/contracts';

export function openStore(path: string) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS previews (id TEXT PRIMARY KEY, created_at TEXT NOT NULL, report TEXT NOT NULL)');
  const insert = db.prepare('INSERT INTO previews (id, created_at, report) VALUES (?, ?, ?)');
  const latest = db.prepare('SELECT report FROM previews ORDER BY created_at DESC, id DESC LIMIT 100');
  const decode = (value: unknown): PreviewReport => {
    if (typeof value !== 'string') throw new Error('报告存储内容损坏。');
    const parsed: unknown = JSON.parse(value);
    if (!reportValidator.Check(parsed)) throw new Error('报告版本或内容不符合当前协议。');
    return parsed;
  };
  return {
    add(report: PreviewReport) { insert.run(report.id, report.createdAt, JSON.stringify(report)); },
    list() { return latest.all().map(row => decode(row.report)); },
    close() { db.close(); },
  };
}
