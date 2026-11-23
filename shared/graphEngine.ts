import type {
  ClusterHub,
  MemoryGraph,
  MemoryNode,
  RawMemoryInput,
  SynapseEdge,
  SynapseKind,
} from './types.ts';
import { SYNAPSE_COLORS } from './types.ts';

function hashString(str: string): number {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) / 4294967295;
}

function seededNoise(seed: string, salt: number): number {
  return hashString(`${seed}::${salt}`) * 2 - 1;
}

const DEFAULT_PALETTES: Array<[string, string, string]> = [
  ['#0ea5e9', '#38bdf8', '#082f49'],
  ['#f43f5e', '#fb923c', '#3b0764'],
  ['#8b5cf6', '#22d3ee', '#0f172a'],
  ['#10b981', '#38bdf8', '#064e3b'],
  ['#f59e0b', '#ec4899', '#1e1b4b'],
  ['#6366f1', '#c084fc', '#090d1f'],
];

export function formatDateLabel(timestamp: number): string {
  const d = new Date(timestamp);
  if (Number.isNaN(d.getTime())) return 'Timeless';
  return d.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

export function latLngToCartesian(
  lat: number,
  lng: number,
  radius: number
): [number, number, number] {
  const phi = ((90 - lat) * Math.PI) / 180;
  const theta = ((lng + 180) * Math.PI) / 180;
  const x = -radius * Math.sin(phi) * Math.cos(theta);
  const y = radius * Math.cos(phi);
  const z = radius * Math.sin(phi) * Math.sin(theta);
  return [x, y, z];
}

function fibonacciSpherePoint(index: number, total: number, radius: number): [number, number, number] {
  const safeTotal = Math.max(total, 1);
  const y = 1 - (index / Math.max(safeTotal - 1, 1)) * 2;
  const r = Math.sqrt(Math.max(0, 1 - y * y));
  const goldenAngle = Math.PI * (3 - Math.sqrt(5));
  const theta = goldenAngle * index;
  return [Math.cos(theta) * r * radius, y * radius, Math.sin(theta) * r * radius];
}

function normalizeTag(value: string): string {
  return value.trim();
}

export function buildMemoryGraph(rawInputs: RawMemoryInput[]): MemoryGraph {
  const sorted = [...rawInputs].sort((a, b) => a.timestamp - b.timestamp);

  // Collect unique entities
  const peopleSet = new Set<string>();
  const placeSet = new Set<string>();
  const eventSet = new Set<string>();
  const themeSet = new Set<string>();

  for (const item of sorted) {
    item.people.map(normalizeTag).filter(Boolean).forEach((p) => peopleSet.add(p));
    if (item.locationName.trim()) placeSet.add(item.locationName.trim());
    if (item.event.trim()) eventSet.add(item.event.trim());
    item.themes.map(normalizeTag).filter(Boolean).forEach((t) => themeSet.add(t));
  }

  const eventsList = Array.from(eventSet);
  const peopleList = Array.from(peopleSet);
  const placesList = Array.from(placeSet);
  const themesList = Array.from(themeSet);

  // 1. Build Cluster Hubs for `clusters` mode
  const hubs: ClusterHub[] = [];
  const hubMap = new Map<string, ClusterHub>();

  const hubEntries: Array<{ kind: 'person' | 'place' | 'event'; label: string }> = [
    ...peopleList.slice(0, 14).map((label) => ({ kind: 'person' as const, label })),
    ...placesList.slice(0, 14).map((label) => ({ kind: 'place' as const, label })),
    ...eventsList.slice(0, 14).map((label) => ({ kind: 'event' as const, label })),
  ];

  const countByKey = new Map<string, number>();
  for (const m of sorted) {
    for (const p of m.people) {
      const k = `person:${p}`;
      countByKey.set(k, (countByKey.get(k) || 0) + 1);
    }
    if (m.locationName) {
      const k = `place:${m.locationName}`;
      countByKey.set(k, (countByKey.get(k) || 0) + 1);
    }
    if (m.event) {
      const k = `event:${m.event}`;
      countByKey.set(k, (countByKey.get(k) || 0) + 1);
    }
  }

  hubEntries.forEach((entry, idx) => {
    const bandRadius = entry.kind === 'person' ? 46 : entry.kind === 'place' ? 58 : 34;
    const pos = fibonacciSpherePoint(idx, hubEntries.length, bandRadius);
    const key = `${entry.kind}:${entry.label}`;
    const hub: ClusterHub = {
      id: key,
      kind: entry.kind,
      label: entry.label,
      color: SYNAPSE_COLORS[entry.kind],
      count: countByKey.get(key) || 1,
      position: pos,
    };
    hubs.push(hub);
    hubMap.set(key, hub);
  });

  // 2. Anchor regions on the inside-out Neural Dome per event so memories form cortical neighborhoods
  const eventAnchors = new Map<string, [number, number, number]>();
  eventsList.forEach((ev, idx) => {
    eventAnchors.set(ev, fibonacciSpherePoint(idx, eventsList.length, 74));
  });

  // Track identical geo buckets so overlapping GPS pins fan out into glowing local bursts
  const geoBucketCounts = new Map<string, number>();

  const memories: MemoryNode[] = sorted.map((item, idx) => {
    const palette =
      item.palette ??
      DEFAULT_PALETTES[Math.floor(hashString(item.id) * DEFAULT_PALETTES.length) % DEFAULT_PALETTES.length];

    // --- Neural Dome position (even 360° cortical shell R = 54..80 around viewer) ---
    const fib = fibonacciSpherePoint(idx, sorted.length, 68);
    const anchor = eventAnchors.get(item.event) ?? fib;
    // Blend 65% golden-sphere distribution + 35% event anchor so memories fill the entire 360° dome cleanly
    let nx = fib[0] * 0.65 + anchor[0] * 0.35 + seededNoise(item.id, 1) * 10;
    let ny = fib[1] * 0.65 + anchor[1] * 0.35 + seededNoise(item.id, 2) * 10;
    let nz = fib[2] * 0.65 + anchor[2] * 0.35 + seededNoise(item.id, 3) * 10;
    const nLen = Math.hypot(nx, ny, nz) || 1;
    const targetShellR = 54 + hashString(`${item.id}:r`) * 24;
    nx = (nx / nLen) * targetShellR;
    ny = (ny / nLen) * targetShellR;
    nz = (nz / nLen) * targetShellR;

    // --- Geographic Globe position ---
    let globePos: [number, number, number];
    if (typeof item.lat === 'number' && typeof item.lng === 'number' && (item.lat !== 0 || item.lng !== 0)) {
      const bucketKey = `${item.lat.toFixed(2)},${item.lng.toFixed(2)}`;
      const bucketIndex = geoBucketCounts.get(bucketKey) || 0;
      geoBucketCounts.set(bucketKey, bucketIndex + 1);

      // Gentle spiral offset around the exact GPS coordinate so memories in the same city form a delicate halo
      const angle = bucketIndex * 2.39996;
      const spreadDeg = Math.min(bucketIndex * 1.4, 6.0);
      const latOffset = Math.cos(angle) * spreadDeg * 0.65;
      const lngOffset = Math.sin(angle) * spreadDeg;
      const altitude = 62.0 + (bucketIndex % 5) * 1.9;
      globePos = latLngToCartesian(
        Math.max(-85, Math.min(85, item.lat + latOffset)),
        item.lng + lngOffset,
        altitude
      );
    } else {
      // Orbital memory halo for non-geotagged memories
      const angle = (idx / Math.max(sorted.length, 1)) * Math.PI * 2;
      const r = 74 + seededNoise(item.id, 7) * 5;
      const y = seededNoise(item.id, 8) * 14;
      globePos = [Math.cos(angle) * r, y, Math.sin(angle) * r];
    }

    // --- Clusters position (weighted centroid of its hubs + local orbit) ---
    const relatedHubs: ClusterHub[] = [];
    for (const p of item.people) {
      const h = hubMap.get(`person:${p}`);
      if (h) relatedHubs.push(h);
    }
    const placeHub = hubMap.get(`place:${item.locationName}`);
    if (placeHub) relatedHubs.push(placeHub);
    const eventHub = hubMap.get(`event:${item.event}`);
    if (eventHub) relatedHubs.push(eventHub);

    let cx = 0;
    let cy = 0;
    let cz = 0;
    if (relatedHubs.length > 0) {
      for (const h of relatedHubs) {
        cx += h.position[0];
        cy += h.position[1];
        cz += h.position[2];
      }
      cx /= relatedHubs.length;
      cy /= relatedHubs.length;
      cz /= relatedHubs.length;
      cx += seededNoise(item.id, 11) * 14;
      cy += seededNoise(item.id, 12) * 14;
      cz += seededNoise(item.id, 13) * 14;
    } else {
      const fallback = fibonacciSpherePoint(idx, sorted.length, 48);
      cx = fallback[0];
      cy = fallback[1];
      cz = fallback[2];
    }

    return {
      ...item,
      dateLabel: formatDateLabel(item.timestamp),
      palette,
      positions: {
        neural: [nx, ny, nz],
        globe: globePos,
        clusters: [cx, cy, cz],
      },
      degree: 0,
    };
  });

  // 3. Build Synaptic Connections (rich yet uncluttered: cap max synapses per node so it looks like a glowing neural web, not a hairball)
  const candidatesByNode = new Map<string, Array<{ other: string; edge: SynapseEdge }>>();
  const pairSeen = new Set<string>();

  for (let i = 0; i < memories.length; i++) {
    const a = memories[i];
    for (let j = i + 1; j < memories.length; j++) {
      const b = memories[j];
      const reasons: Array<{ kind: SynapseKind; label: string }> = [];
      let score = 0;

      // Shared event
      if (a.event && b.event && a.event === b.event) {
        reasons.push({ kind: 'event', label: a.event });
        score += 0.55;
      }

      // Shared people
      for (const person of a.people) {
        if (b.people.includes(person)) {
          reasons.push({ kind: 'person', label: person });
          score += 0.48;
        }
      }

      // Shared place
      if (a.locationName && b.locationName && a.locationName === b.locationName) {
        reasons.push({ kind: 'place', label: a.locationName });
        score += 0.42;
      }

      // Shared themes
      for (const theme of a.themes) {
        if (b.themes.includes(theme)) {
          reasons.push({ kind: 'theme', label: theme });
          score += 0.36;
        }
      }

      // Temporal proximity (within 4 days)
      const daysDiff = Math.abs(a.timestamp - b.timestamp) / (1000 * 60 * 60 * 24);
      if (daysDiff <= 4 && reasons.length === 0) {
        reasons.push({ kind: 'event', label: 'Same Week' });
        score += 0.3;
      }

      if (reasons.length === 0) continue;

      // Prefer diverse cross-memory synapses (people/themes bridging different events get a boost!)
      const isCrossEvent = a.event !== b.event;
      const primaryReason =
        (isCrossEvent ? reasons.find((r) => r.kind === 'person' || r.kind === 'theme') : undefined) ??
        reasons[0];

      const weight = Math.min(1, score + (isCrossEvent ? 0.14 : 0));
      const edge: SynapseEdge = {
        id: `${a.id}__${b.id}`,
        source: a.id,
        target: b.id,
        kind: primaryReason.kind,
        label: primaryReason.label,
        weight,
        reasons,
      };

      if (!candidatesByNode.has(a.id)) candidatesByNode.set(a.id, []);
      if (!candidatesByNode.has(b.id)) candidatesByNode.set(b.id, []);
      candidatesByNode.get(a.id)!.push({ other: b.id, edge });
      candidatesByNode.get(b.id)!.push({ other: a.id, edge });
    }
  }

  // Keep top K strongest synapses per node (plus ensure cross-event bridges exist so you can traverse the whole brain!)
  const MAX_SYNAPSES_PER_NODE = memories.length > 150 ? 4 : 6;
  const edges: SynapseEdge[] = [];

  for (const node of memories) {
    const list = candidatesByNode.get(node.id) ?? [];
    list.sort((x, y) => y.edge.weight - x.edge.weight);

    // Pick a balanced mix: top same-event/place links + top cross-event neural bridges
    const selected: SynapseEdge[] = [];
    const crossLinks = list.filter((c) => c.edge.kind === 'person' || c.edge.kind === 'theme').slice(0, 3);
    const otherLinks = list.filter((c) => !crossLinks.includes(c));

    for (const c of [...crossLinks, ...otherLinks]) {
      if (selected.length >= MAX_SYNAPSES_PER_NODE) break;
      selected.push(c.edge);
    }

    for (const edge of selected) {
      if (!pairSeen.has(edge.id)) {
        pairSeen.add(edge.id);
        edges.push(edge);
      }
    }
  }

  // Ensure temporal backbone connects any isolated node so the entire memory globe is traversable
  const degreeMap = new Map<string, number>();
  for (const e of edges) {
    degreeMap.set(e.source, (degreeMap.get(e.source) || 0) + 1);
    degreeMap.set(e.target, (degreeMap.get(e.target) || 0) + 1);
  }

  for (let i = 0; i < memories.length - 1; i++) {
    const a = memories[i];
    const b = memories[i + 1];
    if ((degreeMap.get(a.id) || 0) < 2) {
      const key = `${a.id}__${b.id}`;
      if (!pairSeen.has(key)) {
        pairSeen.add(key);
        edges.push({
          id: key,
          source: a.id,
          target: b.id,
          kind: 'event',
          label: 'Timeline Thread',
          weight: 0.42,
          reasons: [{ kind: 'event', label: 'Timeline Thread' }],
        });
        degreeMap.set(a.id, (degreeMap.get(a.id) || 0) + 1);
        degreeMap.set(b.id, (degreeMap.get(b.id) || 0) + 1);
      }
    }
  }

  for (const m of memories) {
    m.degree = degreeMap.get(m.id) || 0;
  }

  const sources = new Set(memories.map((m) => m.source));
  const source: MemoryGraph['stats']['source'] =
    sources.size === 1 && sources.has('demo')
      ? 'demo'
      : sources.has('demo')
      ? 'mixed'
      : 'imported';

  return {
    memories,
    edges,
    hubs,
    stats: {
      totalMemories: memories.length,
      totalSynapses: edges.length,
      people: peopleList,
      places: placesList,
      events: eventsList,
      themes: themesList,
      source,
    },
  };
}
