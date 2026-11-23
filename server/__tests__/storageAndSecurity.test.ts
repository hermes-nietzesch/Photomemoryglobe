import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type http from 'node:http';
import { MemoryStore } from '../memoryStore.ts';
import { createServerApp } from '../index.ts';
import type { RawMemoryInput } from '../../shared/types.ts';

// Minimal valid 1x1 PNG buffer
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64'
);

const SAMPLE_DEMO: RawMemoryInput[] = [
  {
    id: 'demo-1',
    title: 'Demo Sunset',
    caption: 'Demo memory',
    timestamp: Date.parse('2025-01-01T12:00:00Z'),
    locationName: 'Lisbon, Portugal',
    lat: 38.72,
    lng: -9.14,
    people: ['Maya'],
    event: 'Demo Trip',
    themes: ['Golden Hour'],
    mood: 'Calm',
    source: 'demo',
  },
];

const IMPORTED_MEM: RawMemoryInput = {
  id: 'mem-real-1',
  title: 'Real Imported Photo',
  caption: 'Imported from folder',
  timestamp: Date.parse('2025-06-15T18:30:00Z'),
  locationName: 'Kyoto, Japan',
  lat: 35.01,
  lng: 135.77,
  people: ['Kenji'],
  event: 'Kyoto Walk',
  themes: ['Architecture'],
  mood: 'Serene',
  source: 'takeout',
};

describe('MemoryStore — atomic saves & damaged-index recovery (Issue #1)', () => {
  let tmpDir: string;
  let storePath: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'synapse-store-test-'));
    storePath = path.join(tmpDir, 'memories.json');
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('distinguishes missing index on first launch as clean demo state', async () => {
    const store = new MemoryStore({ storePath, demoMemories: SAMPLE_DEMO });
    const loaded = await store.load();

    assert.equal(loaded.state, 'demo');
    assert.equal(loaded.recovery, null);
    assert.equal(loaded.memories.length, 1);
    assert.equal(loaded.memories[0].id, 'demo-1');
  });

  it('writes atomically via temp file + rename with no leftover .tmp files', async () => {
    const store = new MemoryStore({ storePath, demoMemories: SAMPLE_DEMO });
    await store.load();
    await store.save([IMPORTED_MEM]);

    const files = await fs.readdir(tmpDir);
    assert.deepEqual(files, ['memories.json']);

    // Verify a fresh instance reloads the saved data cleanly
    const reloaded = new MemoryStore({ storePath, demoMemories: SAMPLE_DEMO });
    const result = await reloaded.load();
    assert.equal(result.state, 'loaded');
    assert.equal(result.recovery, null);
    assert.equal(result.memories[0].id, 'mem-real-1');
  });

  it('preserves a damaged/truncated index untouched on restart and surfaces recovery info', async () => {
    const corruptedContent = '[{"id":"mem-partial","title":"Interrupted write';
    await fs.writeFile(storePath, corruptedContent, 'utf-8');

    const store = new MemoryStore({ storePath, demoMemories: SAMPLE_DEMO });
    const loaded = await store.load();

    assert.equal(loaded.state, 'damaged');
    assert.ok(loaded.recovery);
    assert.equal(loaded.recovery.code, 'DAMAGED_INDEX');
    assert.equal(loaded.recovery.damagedPath, storePath);

    // Crucial: the damaged file on disk must remain byte-for-byte intact
    const onDisk = await fs.readFile(storePath, 'utf-8');
    assert.equal(onDisk, corruptedContent);
  });

  it('archives a damaged index before resetting or saving a new library', async () => {
    const corruptedContent = '{ not-an-array: true';
    await fs.writeFile(storePath, corruptedContent, 'utf-8');

    const store = new MemoryStore({ storePath, demoMemories: SAMPLE_DEMO });
    await store.load();
    assert.equal(store.getState(), 'damaged');

    const { archivedDamagedPath } = await store.resetToDemo();
    assert.ok(archivedDamagedPath);
    const archivedBytes = await fs.readFile(archivedDamagedPath, 'utf-8');
    assert.equal(archivedBytes, corruptedContent);
    assert.equal(store.getState(), 'demo');
    assert.equal(store.getRecovery(), null);
  });

  it('handles concurrent saves cleanly without corrupting the index', async () => {
    const store = new MemoryStore({ storePath, demoMemories: SAMPLE_DEMO });
    await store.load();

    await Promise.all(
      [1, 2, 3, 4, 5].map((n) =>
        store.save([{ ...IMPORTED_MEM, id: `mem-batch-${n}`, title: `Batch ${n}` }])
      )
    );

    const files = await fs.readdir(tmpDir);
    assert.deepEqual(files, ['memories.json']);

    const parsed = JSON.parse(await fs.readFile(storePath, 'utf-8')) as RawMemoryInput[];
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0].id, 'mem-batch-5');
  });
});

describe('Local Photo API — origin restriction & end-to-end persistence (Issue #1)', () => {
  let tmpDir: string;
  let dataDir: string;
  let photosDir: string;
  let server: http.Server;
  let baseUrl: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'synapse-api-test-'));
    dataDir = path.join(tmpDir, '.data');
    photosDir = path.join(tmpDir, 'Takeout', 'Kyoto Autumn');
    await fs.mkdir(photosDir, { recursive: true });
    await fs.writeFile(path.join(photosDir, 'shrine.png'), TINY_PNG);
    await fs.writeFile(
      path.join(photosDir, 'shrine.png.json'),
      JSON.stringify({
        title: 'shrine.png',
        description: 'Morning mist at Fushimi Inari',
        photoTakenTime: { timestamp: '1730701320' },
        geoData: { latitude: 34.9671, longitude: 135.7727 },
        people: [{ name: 'Maya' }],
      })
    );

    const { app, store } = createServerApp({
      dataDir,
      demoMemories: SAMPLE_DEMO,
    });
    await store.load();

    server = await new Promise<http.Server>((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve()))
    );
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('allows same-origin local app to import, read graph, and load photo media without wildcard CORS', async () => {
    // 1. Import via trusted local app origin
    const importRes = await fetch(`${baseUrl}/api/import/folder`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'http://localhost:5173',
        'Sec-Fetch-Site': 'same-origin',
      },
      body: JSON.stringify({ folderPath: photosDir }),
    });
    assert.equal(importRes.status, 200);
    assert.equal(importRes.headers.get('access-control-allow-origin'), null);
    assert.equal(importRes.headers.get('cross-origin-resource-policy'), 'same-origin');

    const imported = (await importRes.json()) as {
      imported: number;
      matchedSidecars: number;
      graph: { memories: Array<{ id: string; imageUrl?: string }> };
    };
    assert.equal(imported.imported, 1);
    assert.equal(imported.matchedSidecars, 1);

    const memId = imported.graph.memories[0].id;
    assert.ok(memId);

    // 2. Same-origin media fetch returns the actual PNG
    const mediaRes = await fetch(`${baseUrl}/api/media/${memId}`, {
      headers: { 'Sec-Fetch-Site': 'same-origin' },
    });
    assert.equal(mediaRes.status, 200);
    assert.equal(mediaRes.headers.get('cross-origin-resource-policy'), 'same-origin');
    const bytes = Buffer.from(await mediaRes.arrayBuffer());
    assert.deepEqual(bytes, TINY_PNG);
  });

  it('blocks unrelated browser origins from reading the collection, loading media, or mutating state', async () => {
    // First import a real photo so we can confirm evil origins cannot reset or read it
    const setupRes = await fetch(`${baseUrl}/api/import/folder`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'http://localhost:5173',
        'Sec-Fetch-Site': 'same-origin',
      },
      body: JSON.stringify({ folderPath: photosDir }),
    });
    assert.equal(setupRes.status, 200);
    const { graph } = (await setupRes.json()) as {
      graph: { memories: Array<{ id: string }> };
    };
    const memId = graph.memories[0].id;

    // 1. Cross-origin GET /api/graph blocked
    const evilGet = await fetch(`${baseUrl}/api/graph`, {
      headers: {
        Origin: 'https://evil.example',
        'Sec-Fetch-Site': 'cross-site',
      },
    });
    assert.equal(evilGet.status, 403);
    assert.equal(evilGet.headers.get('access-control-allow-origin'), null);

    // 2. Cross-site <img> load of /api/media/:id blocked
    const evilImg = await fetch(`${baseUrl}/api/media/${memId}`, {
      headers: {
        'Sec-Fetch-Site': 'cross-site',
      },
    });
    assert.equal(evilImg.status, 403);
    assert.equal(evilImg.headers.get('cross-origin-resource-policy'), 'same-origin');

    // 3. Cross-origin preflight OPTIONS rejected with no CORS headers
    const evilPreflight = await fetch(`${baseUrl}/api/import/folder`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://evil.example',
        'Access-Control-Request-Method': 'POST',
      },
    });
    assert.equal(evilPreflight.status, 403);
    assert.equal(evilPreflight.headers.get('access-control-allow-origin'), null);

    // 4. Cross-origin POST /api/reset-demo rejected
    const evilReset = await fetch(`${baseUrl}/api/reset-demo`, {
      method: 'POST',
      headers: {
        Origin: 'https://evil.example',
        'Sec-Fetch-Site': 'cross-site',
      },
    });
    assert.equal(evilReset.status, 403);

    // 5. Originless POST /api/reset-demo rejected
    const bareReset = await fetch(`${baseUrl}/api/reset-demo`, {
      method: 'POST',
    });
    assert.equal(bareReset.status, 403);

    // Confirm the imported collection was NOT altered by any blocked request
    const checkStatus = await fetch(`${baseUrl}/api/status`, {
      headers: { 'Sec-Fetch-Site': 'same-origin' },
    });
    const statusJson = (await checkStatus.json()) as { storageState: string; memoryCount: number };
    assert.equal(statusJson.storageState, 'loaded');
    assert.equal(statusJson.memoryCount, 1);
  });

  it('restarting the server with a damaged index preserves it and exposes recovery info via /api/status and /api/graph', async () => {
    const damagedPayload = '[{"id":"broken-half-written';
    const storePath = path.join(dataDir, 'memories.json');
    await fs.mkdir(dataDir, { recursive: true });
    await fs.writeFile(storePath, damagedPayload, 'utf-8');

    const restarted = createServerApp({ dataDir, demoMemories: SAMPLE_DEMO });
    await restarted.store.load();
    const restartedServer = await new Promise<http.Server>((resolve) => {
      const s = restarted.app.listen(0, '127.0.0.1', () => resolve(s));
    });
    const addr = restartedServer.address() as AddressInfo;
    const restartedUrl = `http://127.0.0.1:${addr.port}`;

    try {
      const statusRes = await fetch(`${restartedUrl}/api/status`, {
        headers: { 'Sec-Fetch-Site': 'same-origin' },
      });
      assert.equal(statusRes.status, 200);
      const status = (await statusRes.json()) as {
        storageState: string;
        storageRecovery: { code: string; damagedPath: string; message: string } | null;
      };
      assert.equal(status.storageState, 'damaged');
      assert.ok(status.storageRecovery);
      assert.equal(status.storageRecovery.code, 'DAMAGED_INDEX');
      assert.equal(status.storageRecovery.damagedPath, storePath);

      const graphRes = await fetch(`${restartedUrl}/api/graph`, {
        headers: { 'Sec-Fetch-Site': 'same-origin' },
      });
      const graph = (await graphRes.json()) as {
        storageState: string;
        storageRecovery: { code: string } | null;
      };
      assert.equal(graph.storageState, 'damaged');
      assert.equal(graph.storageRecovery?.code, 'DAMAGED_INDEX');

      // Damaged file must remain untouched on disk
      assert.equal(await fs.readFile(storePath, 'utf-8'), damagedPayload);
    } finally {
      await new Promise<void>((resolve, reject) =>
        restartedServer.close((err) => (err ? reject(err) : resolve()))
      );
    }
  });
});
