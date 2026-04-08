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
    `CREATE TABLE IF NOT EXISTS bundle_reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      bundle_name TEXT NOT NULL,
      bundle_barcode TEXT NOT NULL,
      quantity INTEGER NOT NULL,
      item_barcode TEXT NOT NULL,
      item_name TEXT NOT NULL,
      created_at TEXT NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_bundle_reports_bundle_barcode ON bundle_reports(bundle_barcode)`,
    `CREATE INDEX IF NOT EXISTS idx_bundle_reports_item_barcode ON bundle_reports(item_barcode)`,
    `CREATE INDEX IF NOT EXISTS idx_bundle_reports_bundle_name ON bundle_reports(bundle_name)`,
    `CREATE TABLE IF NOT EXISTS bundle_master_files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      file_name TEXT NOT NULL,
      imported_at TEXT NOT NULL,
      record_count INTEGER NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 0
    )`,
    `CREATE TABLE IF NOT EXISTS bundle_master_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      file_id INTEGER NOT NULL,
      bundle_name TEXT NOT NULL,
      bundle_barcode TEXT NOT NULL,
      quantity INTEGER NOT NULL,
      item_barcode TEXT NOT NULL,
      item_name TEXT NOT NULL,
      row_number INTEGER NOT NULL,
      FOREIGN KEY(file_id) REFERENCES bundle_master_files(id)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_bundle_master_bundle_barcode ON bundle_master_records(bundle_barcode)`,
    `CREATE INDEX IF NOT EXISTS idx_bundle_master_item_barcode ON bundle_master_records(item_barcode)`,
    `CREATE INDEX IF NOT EXISTS idx_bundle_master_bundle_name ON bundle_master_records(bundle_name)`,
    `CREATE INDEX IF NOT EXISTS idx_bundle_master_item_name ON bundle_master_records(item_name)`,
    `CREATE INDEX IF NOT EXISTS idx_bundle_master_file_id ON bundle_master_records(file_id)`,
    `CREATE TABLE IF NOT EXISTS convert_saved_sets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      source_type TEXT NOT NULL,
      source_file_name TEXT NOT NULL,
      record_count INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_convert_saved_sets_name ON convert_saved_sets(name)`,
    `CREATE INDEX IF NOT EXISTS idx_convert_saved_sets_updated_at ON convert_saved_sets(updated_at)`,
    `CREATE TABLE IF NOT EXISTS convert_saved_rows (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      set_id INTEGER NOT NULL,
      barcode TEXT NOT NULL,
      name TEXT NOT NULL,
      row_number INTEGER NOT NULL,
      FOREIGN KEY(set_id) REFERENCES convert_saved_sets(id)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_convert_saved_rows_set_id ON convert_saved_rows(set_id)`,
    `CREATE INDEX IF NOT EXISTS idx_convert_saved_rows_barcode ON convert_saved_rows(barcode)`,
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

export function getActiveMasterRecords() {
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

export function createBundleReport(payload) {
  const createdAt = getKstTimestamp();
  return run(
    `INSERT INTO bundle_reports (bundle_name, bundle_barcode, quantity, item_barcode, item_name, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [payload.bundleName, payload.bundleBarcode, payload.quantity, payload.itemBarcode, payload.itemName, createdAt],
  ).then((result) => ({
    id: result.lastID,
    createdAt,
  }));
}

export function listBundleReports() {
  return all(
    `SELECT id,
            bundle_name as bundleName,
            bundle_barcode as bundleBarcode,
            quantity,
            item_barcode as itemBarcode,
            item_name as itemName,
            created_at as createdAt
     FROM bundle_reports
     ORDER BY id DESC`,
  );
}

export function updateBundleReport(id, payload) {
  return run(
    `UPDATE bundle_reports
     SET bundle_name = ?,
         bundle_barcode = ?,
         quantity = ?,
         item_barcode = ?,
         item_name = ?
     WHERE id = ?`,
    [payload.bundleName, payload.bundleBarcode, payload.quantity, payload.itemBarcode, payload.itemName, id],
  );
}

export function deleteBundleReport(id) {
  return run('DELETE FROM bundle_reports WHERE id = ?', [id]);
}

export async function replaceBundleMaster({ fileName, records }) {
  const importedAt = new Date().toISOString();
  await run('BEGIN TRANSACTION');

  try {
    await run('UPDATE bundle_master_files SET is_active = 0');
    const insertResult = await run(
      `INSERT INTO bundle_master_files (file_name, imported_at, record_count, is_active)
       VALUES (?, ?, ?, 1)`,
      [fileName, importedAt, records.length],
    );

    const fileId = insertResult.lastID;
    await run('DELETE FROM bundle_master_records WHERE file_id NOT IN (SELECT id FROM bundle_master_files WHERE is_active = 1)');

    const stmt = await prepare(
      `INSERT INTO bundle_master_records (file_id, bundle_name, bundle_barcode, quantity, item_barcode, item_name, row_number)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );

    for (const record of records) {
      await stmtRun(stmt, [
        fileId,
        record.bundleName,
        record.bundleBarcode,
        record.quantity,
        record.itemBarcode,
        record.itemName,
        record.rowNumber,
      ]);
    }

    await finalize(stmt);
    await run('COMMIT');

    return {
      fileId,
      summary: {
        fileName,
        importedAt,
        recordCount: records.length,
      },
    };
  } catch (error) {
    await run('ROLLBACK');
    throw error;
  }
}

export function getBundleMasterSummary() {
  return get(
    `SELECT id, file_name as fileName, imported_at as importedAt, record_count as recordCount
     FROM bundle_master_files
     WHERE is_active = 1
     ORDER BY id DESC
     LIMIT 1`,
  );
}

export function searchBundleMasterRecords(query = '') {
  const trimmed = query.trim();
  if (!trimmed) {
    return all(
      `SELECT bundle_name as bundleName,
              bundle_barcode as bundleBarcode,
              quantity,
              item_barcode as itemBarcode,
              item_name as itemName,
              row_number as rowNumber
       FROM bundle_master_records r
       JOIN bundle_master_files f ON f.id = r.file_id
       WHERE f.is_active = 1
       ORDER BY row_number ASC
       LIMIT 200`,
    );
  }

  const like = `%${trimmed}%`;
  return all(
    `SELECT bundle_name as bundleName,
            bundle_barcode as bundleBarcode,
            quantity,
            item_barcode as itemBarcode,
            item_name as itemName,
            row_number as rowNumber
     FROM bundle_master_records r
     JOIN bundle_master_files f ON f.id = r.file_id
     WHERE f.is_active = 1
       AND (
         bundle_name LIKE ?
         OR bundle_barcode LIKE ?
         OR item_barcode LIKE ?
         OR item_name LIKE ?
       )
     ORDER BY CASE
         WHEN bundle_barcode = ? THEN 0
         WHEN item_barcode = ? THEN 1
         ELSE 2
       END,
       row_number ASC
     LIMIT 200`,
    [like, like, like, like, trimmed, trimmed],
  );
}

export async function createConvertSavedSet(payload) {
  const timestamp = new Date().toISOString();
  await run('BEGIN TRANSACTION');

  try {
    const insertResult = await run(
      `INSERT INTO convert_saved_sets (name, source_type, source_file_name, record_count, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [payload.name, payload.sourceType, payload.sourceFileName, payload.rows.length, timestamp, timestamp],
    );

    const setId = insertResult.lastID;
    const stmt = await prepare(
      `INSERT INTO convert_saved_rows (set_id, barcode, name, row_number)
       VALUES (?, ?, ?, ?)`,
    );

    for (const row of payload.rows) {
      await stmtRun(stmt, [setId, row.barcode, row.name, row.rowNumber]);
    }

    await finalize(stmt);
    await run('COMMIT');

    return getConvertSavedSetDetail(setId);
  } catch (error) {
    await run('ROLLBACK');
    throw error;
  }
}

export function listConvertSavedSets() {
  return all(
    `SELECT id,
            name,
            source_type as sourceType,
            source_file_name as sourceFileName,
            record_count as recordCount,
            created_at as createdAt,
            updated_at as updatedAt
     FROM convert_saved_sets
     ORDER BY updated_at DESC, id DESC`,
  );
}

export async function getConvertSavedSetDetail(id) {
  const summary = await get(
    `SELECT id,
            name,
            source_type as sourceType,
            source_file_name as sourceFileName,
            record_count as recordCount,
            created_at as createdAt,
            updated_at as updatedAt
     FROM convert_saved_sets
     WHERE id = ?`,
    [id],
  );

  if (!summary) return null;

  const rows = await all(
    `SELECT barcode,
            name,
            row_number as rowNumber
     FROM convert_saved_rows
     WHERE set_id = ?
     ORDER BY row_number ASC, id ASC`,
    [id],
  );

  return { ...summary, rows };
}

export async function deleteConvertSavedSet(id) {
  await run('BEGIN TRANSACTION');

  try {
    await run('DELETE FROM convert_saved_rows WHERE set_id = ?', [id]);
    const result = await run('DELETE FROM convert_saved_sets WHERE id = ?', [id]);
    await run('COMMIT');
    return result;
  } catch (error) {
    await run('ROLLBACK');
    throw error;
  }
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

function getKstTimestamp() {
  return new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().replace('Z', '+09:00');
}
