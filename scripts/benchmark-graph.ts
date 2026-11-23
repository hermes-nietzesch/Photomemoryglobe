import { performance } from 'node:perf_hooks';
import { buildMemoryGraph } from '../shared/graphEngine.ts';
import type { RawMemoryInput } from '../shared/types.ts';

function generateHeavilyTaggedAlbum(count: number): RawMemoryInput[] {
  const peoplePool = ['Maya', 'Liam', 'Kenji', 'Sofia', 'Elena', 'Mom', 'Dad', 'Noah', 'Aria', 'Leo'];
  const placePool = [
    { name: 'Kyoto, Japan', lat: 35.01, lng: 135.77 },
    { name: 'Lisbon, Portugal', lat: 38.72, lng: -9.14 },
    { name: 'San Francisco, USA', lat: 37.77, lng: -122.42 },
    { name: 'Reykjavik, Iceland', lat: 64.15, lng: -21.94 },
    { name: 'Amalfi Coast, Italy', lat: 40.63, lng: 14.6 },
    { name: 'New York, USA', lat: 40.71, lng: -74.0 },
  ];
  const eventPool = [
    'Autumn in Japan 2023',
    'Iceland Aurora Run 2024',
    'Amalfi Summer 2024',
    'Lisbon Spring Escape 2025',
    'Home & Bay Rituals 2025',
    'New York Winter 2026',
  ];
  const themePool = [
    'Golden Hour',
    'Shared Meals',
    'Ocean Coastlines',
    'Night Lights',
    'Architecture',
    'Family Moments',
    'Forests & Trails',
    'Quiet Mornings',
  ];

  const startTs = Date.parse('2023-01-01T08:00:00Z');
  const memories: RawMemoryInput[] = [];

  for (let i = 0; i < count; i++) {
    const evIdx = Math.floor((i / count) * eventPool.length);
    const place = placePool[evIdx % placePool.length];
    // Heavily tagged: 3 people + 3 themes per photo
    const people = [
      peoplePool[i % peoplePool.length],
      peoplePool[(i + 3) % peoplePool.length],
      peoplePool[(i + 7) % peoplePool.length],
    ];
    const themes = [
      themePool[i % themePool.length],
      themePool[(i + 2) % themePool.length],
      themePool[(i + 5) % themePool.length],
    ];

    memories.push({
      id: `bench-mem-${String(i).padStart(4, '0')}`,
      title: `Memory #${i + 1}`,
      caption: `Heavily tagged benchmark photo ${i + 1}`,
      timestamp: startTs + evIdx * 180 * 24 * 3600 * 1000 + (i % 250) * 3600 * 1000,
      locationName: place.name,
      lat: place.lat + ((i % 7) - 3) * 0.01,
      lng: place.lng + ((i % 9) - 4) * 0.01,
      people,
      event: eventPool[evIdx],
      themes,
      mood: 'Vivid',
      source: 'takeout',
    });
  }

  return memories;
}

const PHOTO_COUNT = Number(process.argv[2] || 1500);
const RUNS = 5;
const dataset = generateHeavilyTaggedAlbum(PHOTO_COUNT);

const durations: number[] = [];
let peakHeapDeltaMb = 0;
let peakRssMb = 0;
let lastEdgeCount = 0;
let crossEventPersonEdges = 0;

for (let run = 0; run < RUNS; run++) {
  const beforeMem = process.memoryUsage();
  const t0 = performance.now();
  const graph = buildMemoryGraph(dataset);
  const elapsed = performance.now() - t0;
  const afterMem = process.memoryUsage();

  durations.push(elapsed);
  const heapDeltaMb = (afterMem.heapUsed - beforeMem.heapUsed) / (1024 * 1024);
  const rssMb = afterMem.rss / (1024 * 1024);
  if (heapDeltaMb > peakHeapDeltaMb) peakHeapDeltaMb = heapDeltaMb;
  if (rssMb > peakRssMb) peakRssMb = rssMb;
  lastEdgeCount = graph.edges.length;

  if (run === RUNS - 1) {
    const byId = new Map(graph.memories.map((m) => [m.id, m]));
    crossEventPersonEdges = graph.edges.filter((e) => {
      const a = byId.get(e.source);
      const b = byId.get(e.target);
      return a && b && a.event !== b.event && e.reasons.some((r) => r.kind === 'person');
    }).length;
  }
}

const sorted = [...durations].sort((a, b) => a - b);
const median = sorted[Math.floor(sorted.length / 2)];

console.log(
  JSON.stringify(
    {
      photoCount: PHOTO_COUNT,
      runs: RUNS,
      coldMs: Number(durations[0].toFixed(2)),
      medianMs: Number(median.toFixed(2)),
      minMs: Number(sorted[0].toFixed(2)),
      maxMs: Number(sorted[sorted.length - 1].toFixed(2)),
      peakHeapDeltaMb: Number(peakHeapDeltaMb.toFixed(2)),
      peakRssMb: Number(peakRssMb.toFixed(2)),
      synapseEdges: lastEdgeCount,
      crossEventPersonEdges,
    },
    null,
    2
  )
);
