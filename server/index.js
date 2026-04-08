import 'dotenv/config';
import cors from 'cors';
import express from 'express';
import { execFile } from 'child_process';
import { promises as fs } from 'fs';
import multer from 'multer';
import os from 'os';
import path from 'path';
import { promisify } from 'util';
import * as XLSX from 'xlsx';
import {
  createBundleReport,
  createConvertSavedSet,
  deleteBundleReport,
  deleteConvertSavedSet,
  getActiveMasterRecords,
  getActiveMasterSummary,
  getBundleMasterSummary,
  getConvertSavedSetDetail,
  initializeDb,
  listBundleReports,
  listConvertSavedSets,
  replaceActiveMaster,
  replaceBundleMaster,
  searchActiveRecords,
  searchBundleMasterRecords,
  updateBundleReport,
} from './db.js';
import { findBarcodeMatches, parseMasterBuffer } from './masterParser.js';
import { assertPythonCommand, findPythonCandidatesFromWhere, formatPythonAttempt } from './pythonResolver.js';

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });
const port = Number(process.env.PORT ?? 3100);
const execFileAsync = promisify(execFile);
let resolvedPythonCommandPromise = null;

app.use(cors());
app.use(express.json({ limit: '1mb' }));

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, service: 'KRS Master API' });
});

app.get('/api/master/status', async (_req, res, next) => {
  try {
    const active = await getActiveMasterSummary();
    res.json({ active });
  } catch (error) {
    next(error);
  }
});

app.get('/api/master/full', async (_req, res, next) => {
  try {
    const active = await getActiveMasterSummary();
    const records = active ? await getActiveMasterRecords() : [];
    res.json({ active, records });
  } catch (error) {
    next(error);
  }
});

app.post('/api/master/import', upload.single('masterFile'), async (req, res, next) => {
  try {
    if (!req.file) {
      res.status(400).json({ error: 'masterFile is required' });
      return;
    }

    const normalizedFileName = normalizeUploadFileName(req.file.originalname);
    const parsed = parseMasterBuffer(req.file.buffer, normalizedFileName);
    const saved = await replaceActiveMaster(parsed);
    res.json({ ok: true, summary: saved.summary });
  } catch (error) {
    next(error);
  }
});

app.get('/api/search', async (req, res, next) => {
  try {
    const query = String(req.query.q ?? '').trim();
    if (!query) {
      res.json({ items: [] });
      return;
    }

    const items = await searchActiveRecords(query);
    res.json({ items });
  } catch (error) {
    next(error);
  }
});

app.get('/api/match', async (req, res, next) => {
  try {
    const code = String(req.query.code ?? '').trim();
    if (!code) {
      res.json({ items: [] });
      return;
    }

    const records = await getActiveMasterRecords();
    const items = findBarcodeMatches(records, code);
    res.json({ items });
  } catch (error) {
    next(error);
  }
});

app.post('/api/bundles/report', async (req, res, next) => {
  try {
    const payload = normalizeBundleReportPayload(req.body ?? {});
    validateBundleReportPayload(payload);
    const saved = await createBundleReport(payload);
    res.json({ ok: true, id: saved.id, createdAt: saved.createdAt });
  } catch (error) {
    next(error);
  }
});

app.get('/api/bundles/report', async (_req, res, next) => {
  try {
    const items = await listBundleReports();
    res.json({ items });
  } catch (error) {
    next(error);
  }
});

app.put('/api/bundles/report/:id', async (req, res, next) => {
  try {
    const id = Number.parseInt(String(req.params.id ?? ''), 10);
    if (!Number.isInteger(id) || id < 1) {
      throw new Error('VALIDATION: 잘못된 제보 번호입니다.');
    }

    const payload = normalizeBundleReportPayload(req.body ?? {});
    validateBundleReportPayload(payload);
    const result = await updateBundleReport(id, payload);
    if (!result.changes) {
      res.status(404).json({ error: '수정할 제보를 찾지 못했습니다.' });
      return;
    }

    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.delete('/api/bundles/report/:id', async (req, res, next) => {
  try {
    const id = Number.parseInt(String(req.params.id ?? ''), 10);
    if (!Number.isInteger(id) || id < 1) {
      throw new Error('VALIDATION: 잘못된 제보 번호입니다.');
    }

    const result = await deleteBundleReport(id);
    if (!result.changes) {
      res.status(404).json({ error: '삭제할 제보를 찾지 못했습니다.' });
      return;
    }

    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.get('/api/bundles/report/export', async (_req, res, next) => {
  try {
    const reports = await listBundleReports();
    const workbook = XLSX.utils.book_new();
    const rows = reports.map((item) => ({
      '상품명': item.bundleName,
      '번들 바코드': item.bundleBarcode,
      '입수': item.quantity,
      '낱개 바코드': item.itemBarcode,
      '낱개 상품명': item.itemName,
      '등록일시': item.createdAt,
    }));
    const worksheet = XLSX.utils.json_to_sheet(rows);
    XLSX.utils.book_append_sheet(workbook, worksheet, 'BundleReports');
    const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="bundle_reports_${formatDateForFile()}.xlsx"`);
    res.send(buffer);
  } catch (error) {
    next(error);
  }
});

app.get('/api/bundles/master/status', async (_req, res, next) => {
  try {
    const active = await getBundleMasterSummary();
    res.json({ active });
  } catch (error) {
    next(error);
  }
});

app.post('/api/bundles/master/import', upload.single('bundleFile'), async (req, res, next) => {
  try {
    if (!req.file) {
      res.status(400).json({ error: 'bundleFile is required' });
      return;
    }

    const normalizedFileName = normalizeUploadFileName(req.file.originalname);
    const parsed = parseBundleExcel(req.file.buffer);
    const saved = await replaceBundleMaster({
      fileName: normalizedFileName,
      records: parsed.records,
    });
    res.json({ ok: true, summary: saved.summary, warnings: parsed.warnings });
  } catch (error) {
    next(error);
  }
});

app.post('/api/convert/inventory-photo', upload.single('photoFile'), async (req, res, next) => {
  try {
    if (!req.file) {
      res.status(400).json({ error: 'photoFile is required' });
      return;
    }

    const normalizedFileName = normalizeUploadFileName(req.file.originalname);
    const result = await runInventoryPhotoOcr(req.file.buffer, normalizedFileName);
    if (result.engine?.path) {
      console.info(`[OCR] engine=${result.engine.name ?? 'unknown'} path=${result.engine.path} file=${normalizedFileName}`);
    }
    res.json({
      ok: true,
      summary: {
        fileName: normalizedFileName,
        importedAt: new Date().toISOString(),
        recordCount: result.items.length,
      },
      items: result.items,
      warnings: result.warnings,
      engine: result.engine ?? null,
    });
  } catch (error) {
    next(error);
  }
});

app.get('/api/bundles/master/search', async (req, res, next) => {
  try {
    const query = String(req.query.q ?? '').trim();
    const active = await getBundleMasterSummary();
    const items = active ? await searchBundleMasterRecords(query) : [];
    res.json({ active, items });
  } catch (error) {
    next(error);
  }
});

app.get('/api/convert/saved', async (_req, res, next) => {
  try {
    const items = await listConvertSavedSets();
    res.json({ items });
  } catch (error) {
    next(error);
  }
});

app.get('/api/convert/saved/:id', async (req, res, next) => {
  try {
    const id = Number.parseInt(String(req.params.id ?? ''), 10);
    if (!Number.isInteger(id) || id < 1) {
      throw new Error('VALIDATION: 올바른 저장 번호를 입력해 주세요.');
    }

    const item = await getConvertSavedSetDetail(id);
    if (!item) {
      res.status(404).json({ error: '저장된 변환 결과를 찾지 못했습니다.' });
      return;
    }

    res.json({ item });
  } catch (error) {
    next(error);
  }
});

app.post('/api/convert/saved', async (req, res, next) => {
  try {
    const payload = normalizeConvertSavedPayload(req.body ?? {});
    validateConvertSavedPayload(payload);
    const item = await createConvertSavedSet(payload);
    res.status(201).json({ ok: true, item });
  } catch (error) {
    next(error);
  }
});

app.delete('/api/convert/saved/:id', async (req, res, next) => {
  try {
    const id = Number.parseInt(String(req.params.id ?? ''), 10);
    if (!Number.isInteger(id) || id < 1) {
      throw new Error('VALIDATION: 올바른 저장 번호를 입력해 주세요.');
    }

    const result = await deleteConvertSavedSet(id);
    if (!result.changes) {
      res.status(404).json({ error: '삭제할 저장 결과를 찾지 못했습니다.' });
      return;
    }

    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.use((error, _req, res, _next) => {
  console.error(error);

  if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') {
    res.status(413).json({
      error: '업로드 파일이 서버 허용 용량을 초과했습니다.',
    });
    return;
  }

  if (error instanceof Error && error.message.startsWith('VALIDATION:')) {
    res.status(400).json({
      error: error.message.replace('VALIDATION:', '').trim(),
    });
    return;
  }

  if (isSqliteUniqueError(error)) {
    res.status(409).json({
      error: '같은 저장 이름이 이미 있습니다.',
    });
    return;
  }

  res.status(500).json({
    error: error instanceof Error ? error.message : 'Internal Server Error',
  });
});

initializeDb()
  .then(() => {
    app.listen(port, () => {
      console.log(`KRS Master API listening on http://localhost:${port}`);
    });
  })
  .catch((error) => {
    console.error('Failed to initialize database', error);
    process.exit(1);
  });

function normalizeBundleReportPayload(body) {
  return {
    bundleName: String(body.bundleName ?? '').trim(),
    bundleBarcode: String(body.bundleBarcode ?? '').replace(/\D/g, ''),
    quantity: Number.parseInt(String(body.quantity ?? '').trim(), 10),
    itemBarcode: String(body.itemBarcode ?? '').replace(/\D/g, ''),
    itemName: String(body.itemName ?? '').trim(),
  };
}

function validateBundleReportPayload(payload) {
  if (!payload.bundleName) throw new Error('VALIDATION: 상품명을 입력해 주세요.');
  if (byteLength(payload.bundleName) > 30) throw new Error('VALIDATION: 상품명은 30byte 이하여야 합니다.');
  if (!/^\d{1,13}$/.test(payload.bundleBarcode)) throw new Error('VALIDATION: 번들 바코드는 1~13자리 숫자여야 합니다.');
  if (!Number.isInteger(payload.quantity) || payload.quantity < 1 || payload.quantity > 99) {
    throw new Error('VALIDATION: 입수는 1~99 사이 숫자여야 합니다.');
  }
  if (!/^\d{1,13}$/.test(payload.itemBarcode)) throw new Error('VALIDATION: 낱개 바코드는 1~13자리 숫자여야 합니다.');
  if (!payload.itemName) throw new Error('VALIDATION: 낱개 상품명을 입력해 주세요.');
}

function normalizeConvertSavedPayload(body) {
  const rows = Array.isArray(body.rows)
    ? body.rows.map((row, index) => ({
      barcode: String(row?.barcode ?? '').trim(),
      name: String(row?.name ?? '').trim(),
      rowNumber: Number.isInteger(row?.rowNumber) ? row.rowNumber : index + 1,
    }))
    : [];

  return {
    name: String(body.name ?? '').trim(),
    sourceType: String(body.sourceType ?? '').trim(),
    sourceFileName: String(body.sourceFileName ?? '').trim(),
    rows,
  };
}

function validateConvertSavedPayload(payload) {
  if (!payload.name) throw new Error('VALIDATION: 저장 이름을 입력해 주세요.');
  if (payload.sourceType !== 'file' && payload.sourceType !== 'photo') {
    throw new Error('VALIDATION: 저장 종류가 올바르지 않습니다.');
  }
  if (!payload.sourceFileName) throw new Error('VALIDATION: 원본 파일명이 필요합니다.');
  if (!Array.isArray(payload.rows) || payload.rows.length === 0) {
    throw new Error('VALIDATION: 저장할 변환 결과가 없습니다.');
  }

  for (const row of payload.rows) {
    if (!row.barcode || !row.name) {
      throw new Error('VALIDATION: 바코드와 상품명이 모두 있는 결과만 저장할 수 있습니다.');
    }
    if (!Number.isInteger(row.rowNumber) || row.rowNumber < 1) {
      throw new Error('VALIDATION: 행 번호가 올바르지 않습니다.');
    }
  }
}

function parseBundleExcel(buffer) {
  const workbook = XLSX.read(buffer, { type: 'buffer' });
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) {
    throw new Error('번들 마스터 시트를 찾을 수 없습니다.');
  }

  const worksheet = workbook.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json(worksheet, { defval: '', raw: false });
  const warnings = [];
  const records = [];
  const latestByBundleBarcode = new Map();
  const itemBarcodeRows = new Map();

  rows.forEach((row, index) => {
    const mapped = mapBundleRow(row, index + 2);
    if (mapped.kind === 'empty') {
      warnings.push(`${mapped.rowNumber}행은 빈 행이라 건너뛰었습니다.`);
      return;
    }
    if (mapped.kind === 'invalid') {
      warnings.push(mapped.message);
      return;
    }

    if (latestByBundleBarcode.has(mapped.record.bundleBarcode)) {
      const previousRow = latestByBundleBarcode.get(mapped.record.bundleBarcode).rowNumber;
      warnings.push(`${mapped.record.bundleBarcode} 번들바코드가 ${previousRow}행과 ${mapped.rowNumber}행에서 중복되어 ${mapped.rowNumber}행으로 반영했습니다.`);
    }
    latestByBundleBarcode.set(mapped.record.bundleBarcode, { ...mapped.record, rowNumber: mapped.rowNumber });

    if (itemBarcodeRows.has(mapped.record.itemBarcode)) {
      warnings.push(`${mapped.record.itemBarcode} 낱개 바코드가 ${itemBarcodeRows.get(mapped.record.itemBarcode)}행과 ${mapped.rowNumber}행에서 중복되었습니다.`);
    } else {
      itemBarcodeRows.set(mapped.record.itemBarcode, mapped.rowNumber);
    }
  });

  records.push(...latestByBundleBarcode.values());

  if (records.length === 0) {
    throw new Error('번들 마스터에서 저장할 데이터가 없습니다.');
  }

  records.sort((left, right) => left.rowNumber - right.rowNumber);
  return { records, warnings };
}

function mapBundleRow(row, rowNumber) {
  const normalized = Object.fromEntries(
    Object.entries(row).map(([key, value]) => [normalizeHeader(key), String(value ?? '').trim()]),
  );

  const bundleName = readByAliases(normalized, ['번들상품명', '번들 상품명', '번들명', '상품명', 'bundleproductname', 'bundlename']);
  const bundleBarcode = digitsOnly(readByAliases(normalized, ['번들바코드', '번들 바코드', 'bundlebarcode']));
  const quantityRaw = readByAliases(normalized, ['입수', '수량', 'qty', 'quantity']);
  const itemBarcode = digitsOnly(readByAliases(normalized, ['상품코드', '낱개바코드', '낱개 바코드', '개별바코드', 'itembarcode', 'productcode']));
  const itemName = readByAliases(normalized, ['상품명', '낱개상품명', '낱개 상품명', '개별상품명', 'itemname', 'productname']);

  if (!bundleName && !bundleBarcode && !itemBarcode && !itemName) {
    return { kind: 'empty', rowNumber };
  }

  const quantity = Number.parseInt(quantityRaw, 10);
  if (!bundleName || !/^\d{1,13}$/.test(bundleBarcode) || !Number.isInteger(quantity) || !/^\d{1,13}$/.test(itemBarcode) || !itemName) {
    return { kind: 'invalid', rowNumber, message: `${rowNumber}행 형식 오류로 건너뛰었습니다.` };
  }

  return {
    kind: 'valid',
    rowNumber,
    record: {
      bundleName,
      bundleBarcode,
      quantity,
      itemBarcode,
      itemName,
      rowNumber,
    },
  };
}

function readByAliases(row, aliases) {
  for (const alias of aliases) {
    const value = row[normalizeHeader(alias)];
    if (value) return value;
  }
  return '';
}

function normalizeHeader(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[()_\-./]/g, '');
}

function digitsOnly(value) {
  return String(value ?? '').replace(/\D/g, '');
}

function byteLength(value) {
  return Buffer.byteLength(value, 'utf8');
}

function formatDateForFile() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  const hour = String(now.getHours()).padStart(2, '0');
  const minute = String(now.getMinutes()).padStart(2, '0');
  return `${year}${month}${day}_${hour}${minute}`;
}

async function runInventoryPhotoOcr(buffer, originalName) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'krs-photo-ocr-'));
  const inputPath = path.join(tempDir, sanitizeFileName(originalName || 'inventory_photo.jpg'));
  const scriptPath = path.join(process.cwd(), 'server', 'ocr_inventory_table.py');
  const startedAt = Date.now();

  try {
    await fs.writeFile(inputPath, buffer);
    const pythonCommand = await resolvePythonCommand();
    console.info(`[OCR] request_start file=${originalName} python=${pythonCommand}`);
    const pythonArgs = pythonCommand === 'py'
      ? ['-3', scriptPath, inputPath]
      : [scriptPath, inputPath];
    const { stdout, stderr } = await execFileAsync(pythonCommand, pythonArgs, {
      cwd: process.cwd(),
      maxBuffer: 10 * 1024 * 1024,
      env: {
        ...process.env,
        PYTHONIOENCODING: 'utf-8',
      },
    });

    const payload = parsePythonJsonOutput(stdout);
    if (!payload.ok) {
      throw new Error(payload.error || String(stderr || '').trim() || 'OCR 처리에 실패했습니다.');
    }

    const stderrText = String(stderr ?? '').trim();
    if (stderrText) {
      for (const line of stderrText.split(/\r?\n/)) {
        if (line.trim()) console.info(line.trim());
      }
    }
    console.info(`[OCR] request_complete file=${originalName} rows=${Array.isArray(payload.items) ? payload.items.length : 0} elapsedMs=${Date.now() - startedAt}`);
    return {
      items: Array.isArray(payload.items) ? payload.items : [],
      warnings: Array.isArray(payload.warnings) ? payload.warnings : [],
      engine: payload.engine ?? null,
    };
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error('OCR 작업기 응답을 해석하지 못했습니다. Python/Tesseract 설정을 확인해 주세요.');
    }
    if (error && typeof error === 'object' && 'stderr' in error) {
      const stderr = String(error.stderr ?? '').trim();
      if (stderr) {
        throw new Error(stderr);
      }
    }
    throw error;
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

function sanitizeFileName(value) {
  return String(value ?? 'inventory_photo.jpg').replace(/[<>:"/\\|?*\x00-\x1F]/g, '_');
}

function normalizeUploadFileName(fileName) {
  const original = String(fileName ?? '').trim();
  if (!original) return 'upload';

  try {
    const recovered = Buffer.from(original, 'latin1').toString('utf8').trim();
    if (looksBetterAsUtf8(original, recovered)) {
      return recovered;
    }
  } catch {
    // Ignore decode issues and keep the original filename.
  }

  return original;
}

function looksBetterAsUtf8(original, recovered) {
  if (!recovered || recovered === original) return false;
  return scoreReadableFileName(recovered) > scoreReadableFileName(original);
}

function scoreReadableFileName(value) {
  let score = 0;
  if (/[\uac00-\ud7a3]/.test(value)) score += 4;
  if (!/[ÃÂÐÑØÞãåæçèéêëìíîïðñòóôõö÷øùúûüýþÿ]/.test(value)) score += 2;
  if (!/[\uFFFD]/.test(value)) score += 1;
  return score;
}

function isSqliteUniqueError(error) {
  return Boolean(
    error
    && typeof error === 'object'
    && 'code' in error
    && error.code === 'SQLITE_CONSTRAINT'
    && 'message' in error
    && typeof error.message === 'string'
    && error.message.includes('UNIQUE'),
  );
}

function parsePythonJsonOutput(stdout) {
  const output = String(stdout ?? '').trim();
  if (!output) {
    throw new SyntaxError('Empty OCR worker output');
  }

  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (!line.startsWith('{') || !line.endsWith('}')) {
      continue;
    }
    return JSON.parse(line);
  }

  return JSON.parse(output);
}

async function resolvePythonCommand() {
  if (!resolvedPythonCommandPromise) {
    resolvedPythonCommandPromise = findPythonCommand().catch((error) => {
      resolvedPythonCommandPromise = null;
      throw error;
    });
  }
  return resolvedPythonCommandPromise;
}

async function findPythonCommand() {
  const candidates = [
    process.env.PYTHON_EXECUTABLE,
    process.platform === 'win32' ? null : '/usr/bin/python3',
    process.platform === 'win32' ? null : '/usr/local/bin/python3',
    process.platform === 'win32' ? null : '/opt/homebrew/bin/python3',
    'python3',
    'python',
    'py',
    path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'Python', 'Python313', 'python.exe'),
    path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'Python', 'Python310', 'python.exe'),
    path.join('C:', 'Program Files', 'Python313', 'python.exe'),
    path.join('C:', 'Program Files', 'Python310', 'python.exe'),
    ...(await findPythonCandidatesFromWhere()),
  ].filter(Boolean);

  const dedupedCandidates = [...new Set(candidates)];
  const attempted = [];

  for (const candidate of dedupedCandidates) {
    try {
      await assertPythonCommand(candidate);
      return candidate;
    } catch (error) {
      attempted.push(formatPythonAttempt(candidate, error));
    }
  }

  throw new Error('Python 실행 파일을 찾지 못했습니다. PYTHON_EXECUTABLE 또는 PATH를 확인해 주세요.');
}
