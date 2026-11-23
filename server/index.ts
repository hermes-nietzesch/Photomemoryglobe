import express from 'express';
import multer from 'multer';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEMO_MEMORIES } from '../shared/demoMemories.ts';
import { buildMemoryGraph } from '../shared/graphEngine.ts';
import type { MemoryGraph, RawMemoryInput } from '../shared/types.ts';
import { parseSinglePhoto, scanTakeoutFolder } from './takeoutImporter.ts';
import { enrichMemoriesWithGemini } from './geminiEnricher.ts';
import { MemoryStore } from './memoryStore.ts';
import { createLocalApiGuard } from './originGuard.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');

export interface CreateServerOptions {
  dataDir?: string;
  allowedOrigins?: string[];
  demoMemories?: RawMemoryInput[];
}

export function createServerApp(options?: CreateServerOptions) {
  const dataDir = path.resolve(options?.dataDir ?? path.join(ROOT_DIR, '.data'));
  const uploadDir = path.join(dataDir, 'uploads');
  const storePath = path.join(dataDir, 'memories.json');
  const demoMemories = options?.demoMemories ?? DEMO_MEMORIES;

  const store = new MemoryStore({ storePath, demoMemories });

  async function ensureUploadDir(): Promise<void> {
    await fs.mkdir(uploadDir, { recursive: true });
  }

  function buildResponseGraph(): MemoryGraph {
    const graph = buildMemoryGraph(store.getMemories());
    return {
      ...graph,
      storageState: store.getState(),
      storageRecovery: store.getRecovery(),
    };
  }

  const app = express();
  app.disable('x-powered-by');
  app.use('/api', createLocalApiGuard({ allowedOrigins: options?.allowedOrigins }));
  app.use(express.json({ limit: '10mb' }));

  const upload = multer({
    storage: multer.diskStorage({
      destination: async (_req, _file, cb) => {
        await ensureUploadDir();
        cb(null, uploadDir);
      },
      filename: (_req, file, cb) => {
        const safe = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
        cb(null, `${Date.now()}_${safe}`);
      },
    }),
    limits: { fileSize: 25 * 1024 * 1024, files: 120 },
  });

  app.get('/api/status', (_req, res) => {
    const memories = store.getMemories();
    res.json({
      ok: true,
      hasEnvGeminiKey: Boolean(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY),
      memoryCount: memories.length,
      isDemo: store.getState() !== 'loaded',
      storageState: store.getState(),
      storageRecovery: store.getRecovery(),
    });
  });

  app.get('/api/graph', (_req, res) => {
    res.json(buildResponseGraph());
  });

  app.post('/api/storage/reload', async (_req, res) => {
    const loaded = await store.load();
    res.json({
      storageState: loaded.state,
      storageRecovery: loaded.recovery,
      graph: buildResponseGraph(),
    });
  });

  app.get('/api/media/:id', async (req, res) => {
    const mem = store.getMemories().find((m) => m.id === req.params.id);
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

      const result = await scanTakeoutFolder(
        folderPath.trim(),
        Math.min(Math.max(Number(maxPhotos) || 300, 1), 1500)
      );
      if (result.memories.length === 0) {
        res.status(404).json({
          error: 'No supported images (.jpg, .jpeg, .png, .webp) were found in that folder.',
        });
        return;
      }

      const current = store.getMemories();
      let nextMemories: RawMemoryInput[];
      if (append) {
        const existingIds = new Set(current.map((m) => m.id));
        const merged = [
          ...current.filter((m) => m.source !== 'demo'),
          ...result.memories.filter((m) => !existingIds.has(m.id)),
        ];
        nextMemories = merged.length > 0 ? merged : result.memories;
      } else {
        nextMemories = result.memories;
      }

      const { archivedDamagedPath } = await store.save(nextMemories);
      res.json({
        imported: result.memories.length,
        matchedSidecars: result.matchedSidecars,
        archivedDamagedPath,
        graph: buildResponseGraph(),
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
            // ignore invalid sidecar json
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

      const current = store.getMemories();
      const nextMemories = append
        ? [...current.filter((m) => m.source !== 'demo'), ...parsedMemories]
        : parsedMemories;

      const { archivedDamagedPath } = await store.save(nextMemories);
      res.json({
        imported: parsedMemories.length,
        matchedSidecars,
        archivedDamagedPath,
        graph: buildResponseGraph(),
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
      const result = await enrichMemoriesWithGemini(store.getMemories(), {
        apiKey,
        limit: Math.min(Math.max(Number(limit) || 15, 1), 60),
        model,
      });
      await store.save(result.updated);
      res.json({
        enrichedCount: result.enrichedCount,
        errors: result.errors,
        graph: buildResponseGraph(),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Gemini enrichment failed';
      res.status(400).json({ error: message });
    }
  });

  app.post('/api/reset-demo', async (_req, res) => {
    try {
      const { archivedDamagedPath } = await store.resetToDemo();
      res.json({
        archivedDamagedPath,
        graph: buildResponseGraph(),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Reset failed';
      res.status(500).json({ error: message });
    }
  });

  return { app, store, dataDir, uploadDir, storePath };
}

const isDirectEntry =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename);

if (isDirectEntry) {
  const PORT = Number(process.env.PORT || 3001);
  const { app, store } = createServerApp();

  store.load().then((loaded) => {
    if (loaded.state === 'damaged' && loaded.recovery) {
      console.warn(
        `[Synapse API] WARNING: Damaged photo index detected and preserved at ${loaded.recovery.damagedPath} (${loaded.recovery.detail})`
      );
    }
    app.listen(PORT, '127.0.0.1', () => {
      console.log(`[Synapse API] listening on http://127.0.0.1:${PORT} (storage: ${loaded.state})`);
    });
  });
}
