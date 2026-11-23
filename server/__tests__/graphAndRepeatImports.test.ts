import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import type { AddressInfo } from 'node:net';
import type http from 'node:http';
import { createServerApp } from '../index.ts';
import { buildMemoryGraph } from '../../shared/graphEngine.ts';
import type { MemoryGraph, RawMemoryInput } from '../../shared/types.ts';

// Distinct tiny valid PNG buffers (different pixel/chunk data -> unique SHA-256 content hashes)
const PNG_A = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64'
);
const PNG_B = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

const LOCAL_HEADERS = {
  Origin: 'http://localhost:5173',
  'Sec-Fetch-Site': 'same-origin',
};

describe('Graph caching, 1,500-photo scale, repeat imports & cross-year E2E (Issue #1)', () => {
  let tmpDir: string;
  let dataDir: string;
  let album2023Dir: string;
  let album2025Dir: string;
  let combinedRootDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'synapse-e2e-test-'));
    dataDir = path.join(tmpDir, '.data');
    combinedRootDir = path.join(tmpDir, 'Takeout');
    album2023Dir = path.join(combinedRootDir, 'Kyoto Autumn 2023');
    album2025Dir = path.join(combinedRootDir, 'Lisbon Spring 2025');
    await fs.mkdir(album2023Dir, { recursive: true });
    await fs.mkdir(album2025Dir, { recursive: true });

    // Photo 1: Maya in Kyoto (2023)
    await fs.writeFile(path.join(album2023Dir, 'kyoto_gate.png'), PNG_A);
    await fs.writeFile(
      path.join(album2023Dir, 'kyoto_gate.png.json'),
      JSON.stringify({
        title: 'kyoto_gate.png',
        description: 'Dawn walk through Fushimi Inari with Maya',
        photoTakenTime: { timestamp: String(Math.floor(Date.parse('2023-11-04T07:00:00Z') / 1000)) },
        geoData: { latitude: 34.9671, longitude: 135.7727 },
        people: [{ name: 'Maya' }],
      })
    );

    // Photo 2: Maya in Lisbon (2025)
    await fs.writeFile(path.join(album2025Dir, 'lisbon_tram.png'), PNG_B);
    await fs.writeFile(
      path.join(album2025Dir, 'lisbon_tram.png.json'),
      JSON.stringify({
        title: 'lisbon_tram.png',
        description: 'Tram 28 climb up Alfama with Maya',
        photoTakenTime: { timestamp: String(Math.floor(Date.parse('2025-04-12T10:30:00Z') / 1000)) },
        geoData: { latitude: 38.7117, longitude: -9.1303 },
        people: [{ name: 'Maya' }],
      })
    );
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('caches GET /api/graph until the collection changes and invalidates cleanly on mutation', async () => {
    const ctx = createServerApp({ dataDir });
    await ctx.store.load();

    const server = await new Promise<http.Server>((resolve) => {
      const s = ctx.app.listen(0, '127.0.0.1', () => resolve(s));
    });
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    try {
      const res1 = await fetch(`${baseUrl}/api/graph`, { headers: LOCAL_HEADERS });
      assert.equal(res1.status, 200);
      assert.equal(res1.headers.get('x-graph-cache'), 'MISS');
      assert.equal(ctx.getGraphCacheStats().builds, 1);

      // Repeated fetches reuse the cached graph with zero additional rebuilds
      for (let i = 0; i < 4; i++) {
        const res = await fetch(`${baseUrl}/api/graph`, { headers: LOCAL_HEADERS });
        assert.equal(res.status, 200);
        assert.equal(res.headers.get('x-graph-cache'), 'HIT');
      }
      assert.equal(ctx.getGraphCacheStats().builds, 1);
      assert.equal(ctx.getGraphCacheStats().hits, 4);

      // Importing a folder mutates the collection, triggering exactly one rebuild
      const imp = await fetch(`${baseUrl}/api/import/folder`, {
        method: 'POST',
        headers: { ...LOCAL_HEADERS, 'Content-Type': 'application/json' },
        body: JSON.stringify({ folderPath: combinedRootDir }),
      });
      assert.equal(imp.status, 200);
      assert.equal(ctx.getGraphCacheStats().builds, 2);

      // Fetching again hits the freshly built cache
      const resAfter = await fetch(`${baseUrl}/api/graph`, { headers: LOCAL_HEADERS });
      assert.equal(resAfter.headers.get('x-graph-cache'), 'HIT');
      assert.equal(ctx.getGraphCacheStats().builds, 2);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve()))
      );
    }
  });

  it('builds a 1,500-photo heavily tagged album quickly while preserving cross-event person bridges', () => {
    const peoplePool = ['Maya', 'Liam', 'Kenji', 'Sofia', 'Elena', 'Mom', 'Dad', 'Noah'];
    const events = ['Trip 2022', 'Trip 2023', 'Trip 2024', 'Trip 2025', 'Trip 2026'];
    const themes = ['Golden Hour', 'Shared Meals', 'Architecture', 'Night Lights', 'Ocean Coastlines'];
    const startTs = Date.parse('2022-01-01T10:00:00Z');

    const memories: RawMemoryInput[] = Array.from({ length: 1500 }, (_, i) => {
      const evIdx = Math.floor((i / 1500) * events.length);
      return {
        id: `scale-${i}`,
        title: `Photo ${i}`,
        caption: `Scaled photo ${i}`,
        timestamp: startTs + evIdx * 365 * 24 * 3600 * 1000 + (i % 300) * 3600 * 1000,
        locationName: `Place ${evIdx}`,
        lat: 35 + evIdx * 2,
        lng: 135 - evIdx * 20,
        people: [peoplePool[i % peoplePool.length], peoplePool[(i + 3) % peoplePool.length]],
        event: events[evIdx],
        themes: [themes[i % themes.length], themes[(i + 2) % themes.length]],
        mood: 'Vivid',
        source: 'takeout',
      };
    });

    const t0 = performance.now();
    const graph = buildMemoryGraph(memories);
    const elapsedMs = performance.now() - t0;

    assert.equal(graph.memories.length, 1500);
    assert.ok(graph.edges.length >= 1500, 'Expected well-connected graph');
    assert.ok(elapsedMs < 1000, `Expected 1,500-photo graph build under 1000ms, took ${elapsedMs.toFixed(1)}ms`);

    // Ensure cross-event person bridges exist
    const byId = new Map(graph.memories.map((m) => [m.id, m]));
    const crossPersonLinks = graph.edges.filter((e) => {
      const a = byId.get(e.source);
      const b = byId.get(e.target);
      return a && b && a.event !== b.event && e.reasons.some((r) => r.kind === 'person');
    });
    assert.ok(crossPersonLinks.length > 0, 'Expected cross-event person synapses to be preserved');
  });

  it('enforces consistent duplicate policy and separate added/skipped counts on both folder and upload routes', async () => {
    const ctx = createServerApp({ dataDir });
    await ctx.store.load();
    const server = await new Promise<http.Server>((resolve) => {
      const s = ctx.app.listen(0, '127.0.0.1', () => resolve(s));
    });
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    try {
      // --- Route 1: Folder append twice ---
      const folderFirst = await fetch(`${baseUrl}/api/import/folder`, {
        method: 'POST',
        headers: { ...LOCAL_HEADERS, 'Content-Type': 'application/json' },
        body: JSON.stringify({ folderPath: combinedRootDir, append: true }),
      });
      const f1 = (await folderFirst.json()) as {
        added: number;
        skipped: number;
        totalScanned: number;
        graph: MemoryGraph;
      };
      assert.equal(folderFirst.status, 200);
      assert.equal(f1.added, 2);
      assert.equal(f1.skipped, 0);
      assert.equal(f1.totalScanned, 2);
      assert.equal(f1.graph.memories.length, 2);

      const folderSecond = await fetch(`${baseUrl}/api/import/folder`, {
        method: 'POST',
        headers: { ...LOCAL_HEADERS, 'Content-Type': 'application/json' },
        body: JSON.stringify({ folderPath: combinedRootDir, append: true }),
      });
      const f2 = (await folderSecond.json()) as {
        added: number;
        skipped: number;
        totalScanned: number;
        graph: MemoryGraph;
      };
      assert.equal(folderSecond.status, 200);
      assert.equal(f2.added, 0);
      assert.equal(f2.skipped, 2);
      assert.equal(f2.totalScanned, 2);
      assert.equal(f2.graph.memories.length, 2);

      // --- Reset then test Route 2: Upload append twice ---
      await fetch(`${baseUrl}/api/reset-demo`, { method: 'POST', headers: LOCAL_HEADERS });

      const buildUploadForm = () => {
        const form = new FormData();
        form.append('append', 'true');
        form.append('albumLabel', 'Uploaded Album');
        form.append('files', new Blob([PNG_A], { type: 'image/png' }), 'kyoto_gate.png');
        form.append('files', new Blob([PNG_B], { type: 'image/png' }), 'lisbon_tram.png');
        return form;
      };

      const uploadFirst = await fetch(`${baseUrl}/api/import/upload`, {
        method: 'POST',
        headers: LOCAL_HEADERS,
        body: buildUploadForm(),
      });
      const u1 = (await uploadFirst.json()) as {
        added: number;
        skipped: number;
        totalScanned: number;
        graph: MemoryGraph;
      };
      assert.equal(uploadFirst.status, 200);
      assert.equal(u1.added, 2);
      assert.equal(u1.skipped, 0);
      assert.equal(u1.totalScanned, 2);
      assert.equal(u1.graph.memories.length, 2);

      const uploadSecond = await fetch(`${baseUrl}/api/import/upload`, {
        method: 'POST',
        headers: LOCAL_HEADERS,
        body: buildUploadForm(),
      });
      const u2 = (await uploadSecond.json()) as {
        added: number;
        skipped: number;
        totalScanned: number;
        graph: MemoryGraph;
      };
      assert.equal(uploadSecond.status, 200);
      assert.equal(u2.added, 0);
      assert.equal(u2.skipped, 2);
      assert.equal(u2.totalScanned, 2);
      assert.equal(u2.graph.memories.length, 2);

      // Verify duplicate uploaded files were cleaned up on disk (only 2 original images remain)
      const uploadDirFiles = await fs.readdir(ctx.uploadDir);
      assert.equal(uploadDirFiles.length, 2);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve()))
      );
    }
  });

  it('E2E: links one person across two events in different years, survives restart, and keeps count stable on re-import', async () => {
    // 1. Start server #1 and import both 2023 and 2025 albums featuring Maya
    const server1Ctx = createServerApp({ dataDir });
    await server1Ctx.store.load();
    const server1 = await new Promise<http.Server>((resolve) => {
      const s = server1Ctx.app.listen(0, '127.0.0.1', () => resolve(s));
    });
    const url1 = `http://127.0.0.1:${(server1.address() as AddressInfo).port}`;

    let personEdgeId: string;
    try {
      const r1 = await fetch(`${url1}/api/import/folder`, {
        method: 'POST',
        headers: { ...LOCAL_HEADERS, 'Content-Type': 'application/json' },
        body: JSON.stringify({ folderPath: album2023Dir, append: false }),
      });
      assert.equal(r1.status, 200);
      const d1 = (await r1.json()) as { added: number; skipped: number };
      assert.equal(d1.added, 1);
      assert.equal(d1.skipped, 0);

      const r2 = await fetch(`${url1}/api/import/folder`, {
        method: 'POST',
        headers: { ...LOCAL_HEADERS, 'Content-Type': 'application/json' },
        body: JSON.stringify({ folderPath: album2025Dir, append: true }),
      });
      assert.equal(r2.status, 200);
      const d2 = (await r2.json()) as { added: number; skipped: number; graph: MemoryGraph };
      assert.equal(d2.added, 1);
      assert.equal(d2.skipped, 0);
      assert.equal(d2.graph.memories.length, 2);

      // Follow the person connection between the 2023 event and 2025 event
      const mem2023 = d2.graph.memories.find((m) => m.event === 'Kyoto Autumn 2023');
      const mem2025 = d2.graph.memories.find((m) => m.event === 'Lisbon Spring 2025');
      assert.ok(mem2023 && mem2025);
      assert.notEqual(
        new Date(mem2023.timestamp).getUTCFullYear(),
        new Date(mem2025.timestamp).getUTCFullYear()
      );

      const personEdge = d2.graph.edges.find(
        (e) =>
          e.kind === 'person' &&
          e.label === 'Maya' &&
          ((e.source === mem2023.id && e.target === mem2025.id) ||
            (e.source === mem2025.id && e.target === mem2023.id))
      );
      assert.ok(personEdge, 'Expected direct Maya person synapse linking 2023 Kyoto and 2025 Lisbon');
      personEdgeId = personEdge.id;
    } finally {
      await new Promise<void>((resolve, reject) =>
        server1.close((err) => (err ? reject(err) : resolve()))
      );
    }

    // 2. Restart server #2 against the same persisted dataDir
    const server2Ctx = createServerApp({ dataDir });
    const loaded = await server2Ctx.store.load();
    assert.equal(loaded.state, 'loaded');
    const server2 = await new Promise<http.Server>((resolve) => {
      const s = server2Ctx.app.listen(0, '127.0.0.1', () => resolve(s));
    });
    const url2 = `http://127.0.0.1:${(server2.address() as AddressInfo).port}`;

    try {
      // Confirm link survives restart
      const graphRes = await fetch(`${url2}/api/graph`, { headers: LOCAL_HEADERS });
      const graphAfterRestart = (await graphRes.json()) as MemoryGraph;
      assert.equal(graphAfterRestart.memories.length, 2);
      assert.ok(
        graphAfterRestart.edges.some((e) => e.id === personEdgeId && e.kind === 'person' && e.label === 'Maya'),
        'Expected Maya cross-year synapse to survive restart'
      );

      // 3. Re-import the same albums via BOTH folder append AND upload append
      const reFolder = await fetch(`${url2}/api/import/folder`, {
        method: 'POST',
        headers: { ...LOCAL_HEADERS, 'Content-Type': 'application/json' },
        body: JSON.stringify({ folderPath: combinedRootDir, append: true }),
      });
      const reFolderJson = (await reFolder.json()) as {
        added: number;
        skipped: number;
        graph: MemoryGraph;
      };
      assert.equal(reFolderJson.added, 0);
      assert.equal(reFolderJson.skipped, 2);
      assert.equal(reFolderJson.graph.memories.length, 2);

      const uploadForm = new FormData();
      uploadForm.append('append', 'true');
      uploadForm.append('files', new Blob([PNG_A], { type: 'image/png' }), 'kyoto_gate.png');
      uploadForm.append('files', new Blob([PNG_B], { type: 'image/png' }), 'lisbon_tram.png');

      const reUpload = await fetch(`${url2}/api/import/upload`, {
        method: 'POST',
        headers: LOCAL_HEADERS,
        body: uploadForm,
      });
      const reUploadJson = (await reUpload.json()) as {
        added: number;
        skipped: number;
        graph: MemoryGraph;
      };
      assert.equal(reUploadJson.added, 0);
      assert.equal(reUploadJson.skipped, 2);
      assert.equal(reUploadJson.graph.memories.length, 2);
      assert.ok(
        reUploadJson.graph.edges.some((e) => e.id === personEdgeId && e.kind === 'person' && e.label === 'Maya'),
        'Expected Maya cross-year synapse to remain intact after re-imports'
      );
    } finally {
      await new Promise<void>((resolve, reject) =>
        server2.close((err) => (err ? reject(err) : resolve()))
      );
    }
  });

  it('upgrade: backfills contentHash for legacy main index entries while preserving IDs/metadata and skipping re-imports via both routes', async () => {
    const legacyPhotoPath = path.join(album2023Dir, 'kyoto_gate.png');
    const missingPhotoPath = path.join(tmpDir, 'offline-drive', 'missing.png');

    // Simulate an index created by `main` (path-based SHA-1 id, custom enriched metadata, no contentHash)
    const legacyIndex = [
      {
        id: 'mem-legacy-sha1-id',
        title: 'My Hand-Edited Kyoto Title',
        caption: 'Preserved custom reflection from main',
        timestamp: Date.parse('2023-11-04T07:00:00Z'),
        locationName: 'Kyoto, Japan',
        lat: 34.9671,
        lng: 135.7727,
        people: ['Maya', 'Kenji'],
        event: 'Kyoto Autumn 2023',
        themes: ['Golden Hour', 'Architecture'],
        mood: 'Serene',
        imageUrl: '/api/media/mem-legacy-sha1-id',
        filePath: legacyPhotoPath,
        source: 'takeout',
        enriched: true,
      },
      {
        id: 'mem-legacy-offline-id',
        title: 'Unplugged Drive Photo',
        caption: 'Still preserved even if file is currently unreadable',
        timestamp: Date.parse('2022-08-10T15:00:00Z'),
        locationName: 'Reykjavik, Iceland',
        people: ['Liam'],
        event: 'Iceland 2022',
        themes: ['Ocean Coastlines'],
        mood: 'Crisp',
        imageUrl: '/api/media/mem-legacy-offline-id',
        filePath: missingPhotoPath,
        source: 'takeout',
        enriched: false,
      },
    ];

    await fs.mkdir(dataDir, { recursive: true });
    await fs.writeFile(path.join(dataDir, 'memories.json'), JSON.stringify(legacyIndex, null, 2), 'utf-8');

    const ctx = createServerApp({ dataDir });
    const loaded = await ctx.store.load();
    assert.equal(loaded.state, 'loaded');
    assert.equal(loaded.recovery, null);

    // Readable legacy entry got contentHash backfilled while preserving its exact ID and metadata
    const upgradedReadable = ctx.store.getMemories().find((m) => m.id === 'mem-legacy-sha1-id');
    assert.ok(upgradedReadable);
    assert.ok(upgradedReadable.contentHash && upgradedReadable.contentHash.length === 64);
    assert.equal(upgradedReadable.title, 'My Hand-Edited Kyoto Title');
    assert.equal(upgradedReadable.caption, 'Preserved custom reflection from main');
    assert.deepEqual(upgradedReadable.people, ['Maya', 'Kenji']);
    assert.equal(upgradedReadable.enriched, true);

    // Unreadable legacy entry was preserved intact without failing load
    const preservedOffline = ctx.store.getMemories().find((m) => m.id === 'mem-legacy-offline-id');
    assert.ok(preservedOffline);
    assert.equal(preservedOffline.contentHash, undefined);

    // Verify backfilled contentHash was persisted atomically to disk
    const persistedOnDisk = JSON.parse(
      await fs.readFile(path.join(dataDir, 'memories.json'), 'utf-8')
    ) as RawMemoryInput[];
    assert.equal(persistedOnDisk[0].id, 'mem-legacy-sha1-id');
    assert.equal(persistedOnDisk[0].contentHash, upgradedReadable.contentHash);

    const server = await new Promise<http.Server>((resolve) => {
      const s = ctx.app.listen(0, '127.0.0.1', () => resolve(s));
    });
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    try {
      // Legacy media URL still resolves with the original ID
      const mediaRes = await fetch(`${baseUrl}/api/media/mem-legacy-sha1-id`, {
        headers: LOCAL_HEADERS,
      });
      assert.equal(mediaRes.status, 200);
      assert.deepEqual(Buffer.from(await mediaRes.arrayBuffer()), PNG_A);

      // Re-import the same photo through /api/import/folder -> expect 0 added, 1 skipped
      const folderReimport = await fetch(`${baseUrl}/api/import/folder`, {
        method: 'POST',
        headers: { ...LOCAL_HEADERS, 'Content-Type': 'application/json' },
        body: JSON.stringify({ folderPath: album2023Dir, append: true }),
      });
      assert.equal(folderReimport.status, 200);
      const folderJson = (await folderReimport.json()) as {
        added: number;
        skipped: number;
        graph: MemoryGraph;
      };
      assert.equal(folderJson.added, 0);
      assert.equal(folderJson.skipped, 1);
      assert.equal(folderJson.graph.memories.length, 2);
      const afterFolder = folderJson.graph.memories.find((m) => m.id === 'mem-legacy-sha1-id');
      assert.equal(afterFolder?.title, 'My Hand-Edited Kyoto Title');

      // Re-import the same photo through /api/import/upload -> expect 0 added, 1 skipped
      const form = new FormData();
      form.append('append', 'true');
      form.append('files', new Blob([PNG_A], { type: 'image/png' }), 'kyoto_gate.png');
      const uploadReimport = await fetch(`${baseUrl}/api/import/upload`, {
        method: 'POST',
        headers: LOCAL_HEADERS,
        body: form,
      });
      assert.equal(uploadReimport.status, 200);
      const uploadJson = (await uploadReimport.json()) as {
        added: number;
        skipped: number;
        graph: MemoryGraph;
      };
      assert.equal(uploadJson.added, 0);
      assert.equal(uploadJson.skipped, 1);
      assert.equal(uploadJson.graph.memories.length, 2);
      const afterUpload = uploadJson.graph.memories.find((m) => m.id === 'mem-legacy-sha1-id');
      assert.equal(afterUpload?.title, 'My Hand-Edited Kyoto Title');
      assert.equal(afterUpload?.caption, 'Preserved custom reflection from main');

      // Duplicate uploaded file should have been cleaned up
      const uploadFiles = await fs.readdir(ctx.uploadDir);
      assert.equal(uploadFiles.length, 0);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve()))
      );
    }
  });
});
