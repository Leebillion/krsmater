import cors from 'cors';
import express from 'express';
import multer from 'multer';
import {
  getActiveMasterRecords,
  getActiveMasterSummary,
  initializeDb,
  replaceActiveMaster,
  searchActiveRecords,
} from './db.js';
import { findBarcodeMatches, parseMasterBuffer } from './masterParser.js';

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });
const port = Number(process.env.PORT ?? 3100);

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

    const parsed = parseMasterBuffer(req.file.buffer, req.file.originalname);
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

app.use((error, _req, res, _next) => {
  console.error(error);
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
