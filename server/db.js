import fs from 'fs';
import path from 'path';
import sqlite3 from 'sqlite3';

const dataDir = path.resolve(process.cwd(), 'data');
const dbPath = path.join(dataDir, 'krsmaster.sqlite');

if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const db = new sqlite3.Database(dbPath);

export function initializeDb() {
  return execBatch([
    `CREATE TABLE IF NOT EXISTS master_files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      file_name TEXT NOT NULL,
      imported_at TEXT NOT NULL,
      record_count INTEGER NOT NULL,
      fixed_width_rows INTEGER NOT NULL,
      irregular_rows INTEGER NOT NULL,
      encoding_label TEXT NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 0
    )`,
    `CREATE TABLE IF NOT EXISTS master_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      file_id INTEGER NOT NULL,
      barcode TEXT NOT NULL,
      name TEXT NOT NULL,
      short_name TEXT NOT NULL,
      line_number INTEGER NOT NULL,
      raw_line TEXT NOT NULL,
      FOREIGN KEY(file_id) REFERENCES master_files(id)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_master_records_barcode ON master_records(barcode)`,
    `CREATE INDEX IF NOT EXISTS idx_master_records_name ON master_records(name)`,
    `CREATE INDEX IF NOT EXISTS idx_master_records_short_name ON master_records(short_name)`,
    `CREATE INDEX IF NOT EXISTS idx_master_records_file_id ON master_records(file_id)`,
  ]);
}

export async function replaceActiveMaster(parsed) {
  await run('BEGIN TRANSACTION');

  try {
    await run('UPDATE master_files SET is_active = 0');
    const insertResult = await run(
      `INSERT INTO master_files (file_name, imported_at, record_count, fixed_width_rows, irregular_rows, encoding_label, is_active)
       VALUES (?, ?, ?, ?, ?, ?, 1)`,
      [
        parsed.summary.fileName,
        parsed.summary.importedAt,
        parsed.summary.recordCount,
        parsed.summary.fixedWidthRows,
        parsed.summary.irregularRows,
        parsed.summary.encodingLabel,
      ],
    );

    const fileId = insertResult.lastID;
    await run('DELETE FROM master_records WHERE file_id NOT IN (SELECT id FROM master_files WHERE is_active = 1)');

    const stmt = await prepare(
      `INSERT INTO master_records (file_id, barcode, name, short_name, line_number, raw_line)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );

    for (const record of parsed.records) {
      await stmtRun(stmt, [fileId, record.barcode, record.name, record.shortName, record.lineNumber, record.rawLine]);
    }

    await finalize(stmt);
    await run('COMMIT');

    return { fileId, summary: parsed.summary };
  } catch (error) {
    await run('ROLLBACK');
    throw error;
  }
}

export function getActiveMasterSummary() {
  return get(
    `SELECT id, file_name as fileName, imported_at as importedAt, record_count as recordCount,
            fixed_width_rows as fixedWidthRows, irregular_rows as irregularRows,
            encoding_label as encodingLabel
     FROM master_files
     WHERE is_active = 1
     ORDER BY id DESC
     LIMIT 1`,
  );
}

export async function getActiveMasterRecords() {
  return all(
    `SELECT r.barcode, r.name, r.short_name as shortName, r.line_number as lineNumber, r.raw_line as rawLine
     FROM master_records r
     JOIN master_files f ON f.id = r.file_id
     WHERE f.is_active = 1
     ORDER BY r.line_number ASC`,
  );
}

export function searchActiveRecords(query) {
  const like = `%${query}%`;
  return all(
    `SELECT r.barcode, r.name, r.short_name as shortName, r.line_number as lineNumber, r.raw_line as rawLine
     FROM master_records r
     JOIN master_files f ON f.id = r.file_id
     WHERE f.is_active = 1
       AND (r.barcode LIKE ? OR r.name LIKE ? OR r.short_name LIKE ?)
     ORDER BY CASE WHEN r.barcode = ? THEN 0 ELSE 1 END, r.line_number ASC
     LIMIT 50`,
    [like, like, like, query],
  );
}

function execBatch(statements) {
  return new Promise((resolve, reject) => {
    db.serialize(() => {
      db.exec(statements.join(';\n'), (error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  });
}

function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(error) {
      if (error) reject(error);
      else resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
}

function get(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (error, row) => {
      if (error) reject(error);
      else resolve(row ?? null);
    });
  });
}

function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (error, rows) => {
      if (error) reject(error);
      else resolve(rows ?? []);
    });
  });
}

function prepare(sql) {
  return new Promise((resolve, reject) => {
    const stmt = db.prepare(sql, (error) => {
      if (error) reject(error);
      else resolve(stmt);
    });
  });
}

function stmtRun(stmt, params) {
  return new Promise((resolve, reject) => {
    stmt.run(params, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function finalize(stmt) {
  return new Promise((resolve, reject) => {
    stmt.finalize((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}
