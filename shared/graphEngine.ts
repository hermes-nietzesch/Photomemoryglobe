import type {
  ClusterDimension,
  ClusterHub,
  GlobeRegionGroup,
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

const FOUR_DAYS_MS = 4 * 24 * 60 * 60 * 1000;
const BUCKET_EXHAUSTIVE_LIMIT = 40;
const BUCKET_LOCAL_WINDOW = 10;
const BUCKET_STRIDE_SAMPLES = 12;
const TEMPORAL_WINDOW_LIMIT = 14;
export const CLUSTERS_PAGE_SIZE = 16;

export interface ClusterPageResult {
  items: ClusterHub[];
  page: number;
  totalPages: number;
  totalGroups: number;
  pageSize: number;
}

export function getClusterPage(
  hubs: ClusterHub[],
  dimension: ClusterDimension,
  page: number,
  pageSize = CLUSTERS_PAGE_SIZE
): ClusterPageResult {
  const filtered = hubs.filter((h) => h.kind === dimension);
  const totalGroups = filtered.length;
  const totalPages = Math.max(1, Math.ceil(totalGroups / pageSize));
  const safePage = Math.max(0, Math.min(page, totalPages - 1));
  const start = safePage * pageSize;
  return {
    items: filtered.slice(start, start + pageSize),
    page: safePage,
    totalPages,
    totalGroups,
    pageSize,
  };
}

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

function addBucketMembers(
  bucket: number[],
  posInBucket: number,
  selfIdx: number,
  out: Set<number>
): void {
  const len = bucket.length;
  if (len <= 1) return;

  if (len <= BUCKET_EXHAUSTIVE_LIMIT) {
    for (let k = 0; k < len; k++) {
      const idx = bucket[k];
      if (idx !== selfIdx) out.add(idx);
    }
    return;
  }

  // Local temporal window around this memory inside the sorted bucket
  const start = Math.max(0, posInBucket - BUCKET_LOCAL_WINDOW);
  const end = Math.min(len - 1, posInBucket + BUCKET_LOCAL_WINDOW);
  for (let k = start; k <= end; k++) {
    const idx = bucket[k];
    if (idx !== selfIdx) out.add(idx);
  }

  // Evenly strided representatives across the entire bucket so cross-year / cross-event bridges stay connected
  const step = Math.max(1, Math.floor((len - 1) / BUCKET_STRIDE_SAMPLES));
  for (let k = 0; k < len; k += step) {
    const idx = bucket[k];
    if (idx !== selfIdx) out.add(idx);
  }
  const lastIdx = bucket[len - 1];
  if (lastIdx !== selfIdx) out.add(lastIdx);
}

function scorePair(
  a: MemoryNode,
  b: MemoryNode,
  aPeople: Set<string>,
  aThemes: Set<string>
): SynapseEdge | null {
  const reasons: Array<{ kind: SynapseKind; label: string }> = [];
  let score = 0;

  if (a.event && b.event && a.event === b.event) {
    reasons.push({ kind: 'event', label: a.event });
    score += 0.55;
  }

  for (const person of b.people) {
    if (aPeople.has(person)) {
      reasons.push({ kind: 'person', label: person });
      score += 0.48;
    }
  }

  if (a.locationName && b.locationName && a.locationName === b.locationName) {
    reasons.push({ kind: 'place', label: a.locationName });
    score += 0.42;
  }

  for (const theme of b.themes) {
    if (aThemes.has(theme)) {
      reasons.push({ kind: 'theme', label: theme });
      score += 0.36;
    }
  }

  if (reasons.length === 0) {
    const timeDiff = Math.abs(a.timestamp - b.timestamp);
    if (timeDiff <= FOUR_DAYS_MS) {
      reasons.push({ kind: 'event', label: 'Same Week' });
      score += 0.3;
    } else {
      return null;
    }
  }

  const isCrossEvent = a.event !== b.event;
  const primaryReason =
    (isCrossEvent ? reasons.find((r) => r.kind === 'person' || r.kind === 'theme') : undefined) ??
    reasons[0];

  const weight = Math.min(1, score + (isCrossEvent ? 0.14 : 0));
  const [srcId, tgtId] = a.id < b.id ? [a.id, b.id] : [b.id, a.id];

  return {
    id: `${srcId}__${tgtId}`,
    source: srcId,
    target: tgtId,
    kind: primaryReason.kind,
    label: primaryReason.label,
    weight,
    reasons,
  };
}

function layoutPanoramicGroups(count: number): Array<[number, number, number]> {
  if (count <= 0) return [];
  const cols = count <= 4 ? count : count <= 8 ? 4 : count <= 12 ? 4 : 5;
  const rows = Math.ceil(count / cols);

  // Align horizontal axis smoothly with the default Clusters overview camera (yaw = -0.35)
  const yaw = -0.35;
  const rx = Math.cos(yaw);
  const rz = -Math.sin(yaw);
  const fx = Math.sin(yaw);
  const fz = Math.cos(yaw);

  const spacingX = cols <= 3 ? 44 : cols === 4 ? 38 : 32;
  const spacingY = rows <= 2 ? 32 : rows === 3 ? 27 : 23;

  const positions: Array<[number, number, number]> = [];
  for (let i = 0; i < count; i++) {
    const row = Math.floor(i / cols);
    const rowCount = row === rows - 1 ? count - row * cols : cols;
    const col = i % cols;

    // Center each row horizontally; stagger alternating rows slightly for organic constellation flow
    const u = (col - (rowCount - 1) / 2) * spacingX + (row % 2 === 1 && rowCount === cols ? 4.5 : 0);
    const v = ((rows - 1) / 2 - row) * spacingY;
    // Gentle concave amphitheater curve so outer groups sit slightly closer to the viewer
    const normalizedU = u / Math.max(1, (cols * spacingX) / 2);
    const depthCurve = normalizedU * normalizedU * 14 - 4;

    const x = rx * u + fx * depthCurve;
    const y = v;
    const z = rz * u + fz * depthCurve;
    positions.push([x, y, z]);
  }
  return positions;
}

function angularDistanceDeg(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const toRad = Math.PI / 180;
  const dLat = (lat2 - lat1) * toRad;
  const dLng = (lng2 - lng1) * toRad;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLng / 2) ** 2;
  return (2 * Math.atan2(Math.sqrt(a), Math.sqrt(Math.max(0, 1 - a)))) / toRad;
}

function deriveRegionLabel(members: MemoryNode[]): string {
  const names = members.map((m) => m.locationName.trim()).filter(Boolean);
  const uniqueNames = Array.from(new Set(names));
  if (uniqueNames.length === 0) return 'Mapped Region';
  if (uniqueNames.length === 1) return uniqueNames[0];

  // If all locations share the same country suffix (e.g., "Kyoto, Japan", "Tokyo, Japan"), use the country/region
  const countries = uniqueNames.map((n) => {
    const parts = n.split(',').map((p) => p.trim());
    return parts.length > 1 ? parts[parts.length - 1] : n;
  });
  const uniqueCountries = Array.from(new Set(countries));
  if (uniqueCountries.length === 1) {
    // Special case: US coastal cluster -> show most frequent city + region
    if (uniqueCountries[0] === 'USA') {
      const freq = new Map<string, number>();
      for (const n of names) freq.set(n, (freq.get(n) || 0) + 1);
      const top = [...freq.entries()].sort((a, b) => b[1] - a[1])[0][0];
      return top.replace(/, USA$/, ' Area');
    }
    return uniqueCountries[0];
  }

  // Otherwise pick the most frequent city/location
  const freq = new Map<string, number>();
  for (const n of names) freq.set(n, (freq.get(n) || 0) + 1);
  return [...freq.entries()].sort((a, b) => b[1] - a[1])[0][0];
}

function buildGlobeRegionGroups(memories: MemoryNode[]): GlobeRegionGroup[] {
  const geotagged = memories.filter(
    (m) => typeof m.lat === 'number' && typeof m.lng === 'number' && (m.lat !== 0 || m.lng !== 0)
  );
  const unmapped = memories.filter(
    (m) => !(typeof m.lat === 'number' && typeof m.lng === 'number' && (m.lat !== 0 || m.lng !== 0))
  );

  // Agglomerative geographic clustering within 6.5 degrees (~720 km) so neighboring countries stay distinct
  const clusters: Array<{
    lat: number;
    lng: number;
    latSum: number;
    lngSum: number;
    members: MemoryNode[];
  }> = [];
  const MERGE_THRESHOLD_DEG = 6.5;

  for (const mem of geotagged) {
    let bestCluster: (typeof clusters)[number] | null = null;
    let bestDist = Infinity;
    for (const c of clusters) {
      const d = angularDistanceDeg(mem.lat!, mem.lng!, c.lat, c.lng);
      if (d <= MERGE_THRESHOLD_DEG && d < bestDist) {
        bestDist = d;
        bestCluster = c;
      }
    }
    if (bestCluster) {
      bestCluster.members.push(mem);
      bestCluster.latSum += mem.lat!;
      bestCluster.lngSum += mem.lng!;
      bestCluster.lat = bestCluster.latSum / bestCluster.members.length;
      bestCluster.lng = bestCluster.lngSum / bestCluster.members.length;
    } else {
      clusters.push({
        lat: mem.lat!,
        lng: mem.lng!,
        latSum: mem.lat!,
        lngSum: mem.lng!,
        members: [mem],
      });
    }
  }

  // Sort largest clusters first for stable deterministic elevation offsets
  clusters.sort((a, b) => b.members.length - a.members.length);

  const groups: GlobeRegionGroup[] = clusters.map((c, idx) => {
    const sortedMembers = [...c.members].sort((a, b) => b.degree - a.degree || b.timestamp - a.timestamp);
    const rep = sortedMembers[0];
    const label = deriveRegionLabel(sortedMembers);

    // Slight altitude variation if another cluster is nearby (< 18 deg) so labels & pins separate cleanly
    let nearbyCount = 0;
    for (let k = 0; k < idx; k++) {
      if (angularDistanceDeg(c.lat, c.lng, clusters[k].lat, clusters[k].lng) < 18) {
        nearbyCount++;
      }
    }
    const surfacePos = latLngToCartesian(c.lat, c.lng, 54.35);
    const pinPos = latLngToCartesian(c.lat, c.lng, 62.5 + nearbyCount * 3.4);

    return {
      id: `globe:${idx}:${label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
      label,
      lat: c.lat,
      lng: c.lng,
      color: rep.palette[0] || '#22d3ee',
      count: sortedMembers.length,
      memoryIds: sortedMembers.map((m) => m.id),
      representativeId: rep.id,
      surfacePos,
      pinPos,
    };
  });

  if (unmapped.length > 0) {
    const sortedUnmapped = [...unmapped].sort((a, b) => b.degree - a.degree);
    const rep = sortedUnmapped[0];
    groups.push({
      id: 'globe:unmapped',
      label: 'Unmapped Orbit',
      lat: 0,
      lng: 0,
      color: '#a78bfa',
      count: sortedUnmapped.length,
      memoryIds: sortedUnmapped.map((m) => m.id),
      representativeId: rep.id,
      surfacePos: [72, 0, 0],
      pinPos: [76, 6, 0],
    });
  }

  return groups;
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

  // 1. Pre-group memories per dimension for ClusterHubs (wide panoramic layout per dimension)
  const dimensionLists: Record<ClusterDimension, string[]> = {
    event: eventsList,
    person: peopleList,
    place: placesList,
  };

  const eventMembers = new Map<string, RawMemoryInput[]>();
  const personMembers = new Map<string, RawMemoryInput[]>();
  const placeMembers = new Map<string, RawMemoryInput[]>();

  for (const m of sorted) {
    if (m.event) {
      const list = eventMembers.get(m.event) ?? [];
      list.push(m);
      eventMembers.set(m.event, list);
    }
    for (const p of m.people) {
      const list = personMembers.get(p) ?? [];
      list.push(m);
      personMembers.set(p, list);
    }
    if (m.locationName) {
      const list = placeMembers.get(m.locationName) ?? [];
      list.push(m);
      placeMembers.set(m.locationName, list);
    }
  }

  const hubs: ClusterHub[] = [];
  const eventHubPosMap = new Map<string, [number, number, number]>();

  const memberMaps: Record<ClusterDimension, Map<string, RawMemoryInput[]>> = {
    event: eventMembers,
    person: personMembers,
    place: placeMembers,
  };

  for (const kind of ['event', 'person', 'place'] as const) {
    // Keep EVERY distinct group in each dimension (no hard cap); lay out each page of up to 16 groups cleanly
    const labels = dimensionLists[kind]
      .slice()
      .sort(
        (a, b) =>
          (memberMaps[kind].get(b)?.length || 0) - (memberMaps[kind].get(a)?.length || 0) ||
          a.localeCompare(b)
      );

    for (let pageStart = 0; pageStart < labels.length; pageStart += CLUSTERS_PAGE_SIZE) {
      const pageLabels = labels.slice(pageStart, pageStart + CLUSTERS_PAGE_SIZE);
      const positions = layoutPanoramicGroups(pageLabels.length);

      pageLabels.forEach((label, idx) => {
        const members = memberMaps[kind].get(label) ?? [];
        if (members.length === 0) return;
        const pos = positions[idx];
        if (kind === 'event') eventHubPosMap.set(label, pos);

        hubs.push({
          id: `${kind}:${label}`,
          kind,
          label,
          color: SYNAPSE_COLORS[kind],
          count: members.length,
          position: pos,
          memoryIds: members.map((m) => m.id),
          representativeId: members[0].id,
        });
      });
    }
  }

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
      const angle = (idx / Math.max(sorted.length, 1)) * Math.PI * 2;
      const r = 74 + seededNoise(item.id, 7) * 5;
      const y = seededNoise(item.id, 8) * 14;
      globePos = [Math.cos(angle) * r, y, Math.sin(angle) * r];
    }

    // --- Clusters default anchor (its event hub position; individual members fan out on open) ---
    const clusterAnchor = eventHubPosMap.get(item.event) ?? [0, 0, 0];

    return {
      ...item,
      dateLabel: formatDateLabel(item.timestamp),
      palette,
      positions: {
        neural: [nx, ny, nz],
        globe: globePos,
        clusters: [clusterAnchor[0], clusterAnchor[1], clusterAnchor[2]],
      },
      degree: 0,
    };
  });

  // 3. Build Inverted Indexes so synapse scoring scales smoothly on 1,500+ heavily tagged photos
  const byEvent = new Map<string, number[]>();
  const byPerson = new Map<string, number[]>();
  const byPlace = new Map<string, number[]>();
  const byTheme = new Map<string, number[]>();

  // Record each node's index within each bucket for O(1) windowed sampling
  const eventPos = new Int32Array(memories.length);
  const placePos = new Int32Array(memories.length);
  const personPositions: Array<Array<{ bucket: number[]; pos: number }>> = new Array(memories.length);
  const themePositions: Array<Array<{ bucket: number[]; pos: number }>> = new Array(memories.length);

  for (let i = 0; i < memories.length; i++) {
    const m = memories[i];
    if (m.event) {
      let arr = byEvent.get(m.event);
      if (!arr) {
        arr = [];
        byEvent.set(m.event, arr);
      }
      eventPos[i] = arr.length;
      arr.push(i);
    }
    if (m.locationName) {
      let arr = byPlace.get(m.locationName);
      if (!arr) {
        arr = [];
        byPlace.set(m.locationName, arr);
      }
      placePos[i] = arr.length;
      arr.push(i);
    }

    const pEntries: Array<{ bucket: number[]; pos: number }> = [];
    for (const person of m.people) {
      let arr = byPerson.get(person);
      if (!arr) {
        arr = [];
        byPerson.set(person, arr);
      }
      pEntries.push({ bucket: arr, pos: arr.length });
      arr.push(i);
    }
    personPositions[i] = pEntries;

    const tEntries: Array<{ bucket: number[]; pos: number }> = [];
    for (const theme of m.themes) {
      let arr = byTheme.get(theme);
      if (!arr) {
        arr = [];
        byTheme.set(theme, arr);
      }
      tEntries.push({ bucket: arr, pos: arr.length });
      arr.push(i);
    }
    themePositions[i] = tEntries;
  }

  // 4. Select top K synapses per node directly without materializing all O(N^2) pairs in heap memory
  const MAX_SYNAPSES_PER_NODE = memories.length > 150 ? 4 : 6;
  const pairSeen = new Set<string>();
  const edges: SynapseEdge[] = [];
  const candidates = new Set<number>();

  for (let i = 0; i < memories.length; i++) {
    const a = memories[i];
    candidates.clear();

    if (a.event) {
      const bucket = byEvent.get(a.event);
      if (bucket) addBucketMembers(bucket, eventPos[i], i, candidates);
    }
    if (a.locationName) {
      const bucket = byPlace.get(a.locationName);
      if (bucket) addBucketMembers(bucket, placePos[i], i, candidates);
    }
    for (const entry of personPositions[i]) {
      addBucketMembers(entry.bucket, entry.pos, i, candidates);
    }
    for (const entry of themePositions[i]) {
      addBucketMembers(entry.bucket, entry.pos, i, candidates);
    }

    // Bounded temporal neighbors within ±4 days in sorted timestamp order
    for (let j = i - 1; j >= Math.max(0, i - TEMPORAL_WINDOW_LIMIT); j--) {
      if (a.timestamp - memories[j].timestamp > FOUR_DAYS_MS) break;
      candidates.add(j);
    }
    for (let j = i + 1; j <= Math.min(memories.length - 1, i + TEMPORAL_WINDOW_LIMIT); j++) {
      if (memories[j].timestamp - a.timestamp > FOUR_DAYS_MS) break;
      candidates.add(j);
    }

    if (candidates.size === 0) continue;

    const aPeople = new Set(a.people);
    const aThemes = new Set(a.themes);
    const scored: SynapseEdge[] = [];

    for (const j of candidates) {
      const edge = scorePair(a, memories[j], aPeople, aThemes);
      if (edge) scored.push(edge);
    }

    scored.sort((x, y) => y.weight - x.weight);

    // Balanced selection: preserve cross-event person/theme bridges alongside same-event/place neighbors
    const crossLinks: SynapseEdge[] = [];
    const otherLinks: SynapseEdge[] = [];
    for (const e of scored) {
      if ((e.kind === 'person' || e.kind === 'theme') && crossLinks.length < 3) {
        crossLinks.push(e);
      } else {
        otherLinks.push(e);
      }
    }

    let picked = 0;
    for (const edge of [...crossLinks, ...otherLinks]) {
      if (picked >= MAX_SYNAPSES_PER_NODE) break;
      picked++;
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
      const [srcId, tgtId] = a.id < b.id ? [a.id, b.id] : [b.id, a.id];
      const key = `${srcId}__${tgtId}`;
      if (!pairSeen.has(key)) {
        pairSeen.add(key);
        edges.push({
          id: key,
          source: srcId,
          target: tgtId,
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

  // Pick the highest-degree (most connected) memory as each ClusterHub's representative thumbnail
  const memoryById = new Map(memories.map((m) => [m.id, m]));
  for (const hub of hubs) {
    const best = [...hub.memoryIds]
      .map((id) => memoryById.get(id))
      .filter((m): m is MemoryNode => Boolean(m))
      .sort((a, b) => b.degree - a.degree || b.timestamp - a.timestamp)[0];
    if (best) hub.representativeId = best.id;
  }

  const globeGroups = buildGlobeRegionGroups(memories);

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
    globeGroups,
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
