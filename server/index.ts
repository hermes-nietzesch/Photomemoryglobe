import express from 'express';
import cors from 'cors';
import multer from 'multer';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEMO_MEMORIES } from '../shared/demoMemories.ts';
import { buildMemoryGraph } from '../shared/graphEngine.ts';
import type { RawMemoryInput } from '../shared/types.ts';
import { parseSinglePhoto, scanTakeoutFolder } from './takeoutImporter.ts';
import { enrichMemoriesWithGemini } from './geminiEnricher.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT_DIR, '.data');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const STORE_PATH = path.join(DATA_DIR, 'memories.json');

const PORT = Number(process.env.PORT || 3001);

let rawMemories: RawMemoryInput[] = [...DEMO_MEMORIES];

async function ensureDirs(): Promise<void> {
  await fs.mkdir(UPLOAD_DIR, { recursive: true });
}

async function loadPersistedMemories(): Promise<void> {
  await ensureDirs();
  try {
    const raw = await fs.readFile(STORE_PATH, 'utf-8');
    const parsed = JSON.parse(raw) as RawMemoryInput[];
    if (Array.isArray(parsed) && parsed.length > 0) {
      rawMemories = parsed;
    }
  } catch {
    rawMemories = [...DEMO_MEMORIES];
  }
}

async function persistMemories(): Promise<void> {
  await ensureDirs();
  await fs.writeFile(STORE_PATH, JSON.stringify(rawMemories, null, 2), 'utf-8');
}

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

const upload = multer({
  storage: multer.diskStorage({
    destination: async (_req, _file, cb) => {
      await ensureDirs();
      cb(null, UPLOAD_DIR);
    },
    filename: (_req, file, cb) => {
      const safe = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
      cb(null, `${Date.now()}_${safe}`);
    },
  }),
  limits: { fileSize: 25 * 1024 * 1024, files: 120 },
});

app.get('/api/status', (_req, res) => {
  res.json({
    ok: true,
    hasEnvGeminiKey: Boolean(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY),
    memoryCount: rawMemories.length,
    isDemo: rawMemories.every((m) => m.source === 'demo'),
  });
});

app.get('/api/graph', (_req, res) => {
  const graph = buildMemoryGraph(rawMemories);
  res.json(graph);
});

app.get('/api/media/:id', async (req, res) => {
  const mem = rawMemories.find((m) => m.id === req.params.id);
  if (!mem || !mem.filePath) {
    res.status(404).json({ error: 'Media not found' });
    return;
  }
  try {
    await fs.access(mem.filePath);
    res.sendFile(path.resolve(mem.filePath));
  } catch {
    res.status(404).json({ error: 'File unavailable on disk' });
  }
});

app.post('/api/import/folder', async (req, res) => {
  try {
    const { folderPath, maxPhotos = 300, append = false } = req.body as {
      folderPath?: string;
      maxPhotos?: number;
      append?: boolean;
    };
    if (!folderPath || typeof folderPath !== 'string') {
      res.status(400).json({ error: 'Please provide a valid folderPath.' });
      return;
    }

    const result = await scanTakeoutFolder(folderPath.trim(), Math.min(Math.max(Number(maxPhotos) || 300, 1), 1500));
    if (result.memories.length === 0) {
      res.status(404).json({
        error: 'No supported images (.jpg, .jpeg, .png, .webp) were found in that folder.',
      });
      return;
    }

    if (append) {
      const existingIds = new Set(rawMemories.map((m) => m.id));
      const merged = [
        ...rawMemories.filter((m) => m.source !== 'demo'),
        ...result.memories.filter((m) => !existingIds.has(m.id)),
      ];
      rawMemories = merged.length > 0 ? merged : result.memories;
    } else {
      rawMemories = result.memories;
    }

    await persistMemories();
    res.json({
      imported: result.memories.length,
      matchedSidecars: result.matchedSidecars,
      graph: buildMemoryGraph(rawMemories),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to scan folder';
    res.status(400).json({ error: message });
  }
});

app.post('/api/import/upload', upload.array('files', 120), async (req, res) => {
  try {
    const files = (req.files as Express.Multer.File[]) || [];
    if (files.length === 0) {
      res.status(400).json({ error: 'No files uploaded.' });
      return;
    }

    const append = req.body?.append === 'true';
    const albumLabel = typeof req.body?.albumLabel === 'string' ? req.body.albumLabel.trim() : '';

    // Separate sidecar JSONs from image files
    const jsonByKey = new Map<string, Record<string, unknown>>();
    const imageFiles: Express.Multer.File[] = [];

    for (const file of files) {
      const lower = file.originalname.toLowerCase();
      if (lower.endsWith('.json')) {
        try {
          const parsed = JSON.parse(await fs.readFile(file.path, 'utf-8')) as Record<string, unknown>;
          const normalizedKey = file.originalname
            .replace(/\.supplemental-metadata\.json$/i, '')
            .replace(/\.json$/i, '')
            .toLowerCase();
          jsonByKey.set(normalizedKey, parsed);
          if (typeof parsed.title === 'string') {
            jsonByKey.set(parsed.title.toLowerCase(), parsed);
          }
        } catch {
          // ignore invalid json
        }
      } else if (/\.(jpg|jpeg|png|webp|gif|avif)$/i.test(lower)) {
        imageFiles.push(file);
      }
    }

    if (imageFiles.length === 0) {
      res.status(400).json({ error: 'Upload at least one photo (.jpg, .png, .webp).' });
      return;
    }

    const parsedMemories: RawMemoryInput[] = [];
    let matchedSidecars = 0;

    for (const img of imageFiles) {
      const origLower = img.originalname.toLowerCase();
      const sidecar =
        jsonByKey.get(origLower) ??
        jsonByKey.get(origLower.replace(/\.[^.]+$/, '')) ??
        null;
      if (sidecar) matchedSidecars++;

      const mem = await parseSinglePhoto(img.path, {
        overrideSidecar: sidecar as never,
        folderLabel: albumLabel || 'Uploaded Memories',
        source: 'upload',
      });
      parsedMemories.push(mem);
    }

    if (append) {
      rawMemories = [...rawMemories.filter((m) => m.source !== 'demo'), ...parsedMemories];
    } else {
      rawMemories = parsedMemories;
    }

    await persistMemories();
    res.json({
      imported: parsedMemories.length,
      matchedSidecars,
      graph: buildMemoryGraph(rawMemories),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Upload failed';
    res.status(500).json({ error: message });
  }
});

app.post('/api/enrich/gemini', async (req, res) => {
  try {
    const { apiKey, limit = 15, model = 'gemini-4-hydrogen' } = req.body as {
      apiKey?: string;
      limit?: number;
      model?: string;
    };
    const result = await enrichMemoriesWithGemini(rawMemories, {
      apiKey,
      limit: Math.min(Math.max(Number(limit) || 15, 1), 60),
      model,
    });
    rawMemories = result.updated;
    await persistMemories();
    res.json({
      enrichedCount: result.enrichedCount,
      errors: result.errors,
      graph: buildMemoryGraph(rawMemories),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Gemini enrichment failed';
    res.status(400).json({ error: message });
  }
});

app.post('/api/reset-demo', async (_req, res) => {
  rawMemories = [...DEMO_MEMORIES];
  try {
    await fs.unlink(STORE_PATH);
  } catch {
    // ok if file did not exist
  }
  res.json({ graph: buildMemoryGraph(rawMemories) });
});

loadPersistedMemories().then(() => {
  app.listen(PORT, '127.0.0.1', () => {
    console.log(`[Synapse API] listening on http://127.0.0.1:${PORT}`);
  });
});
