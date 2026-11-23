import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import exifr from 'exifr';
import type { RawMemoryInput } from '../shared/types.ts';

const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.avif']);

interface TakeoutMetadata {
  title?: string;
  description?: string;
  photoTakenTime?: { timestamp?: string; formatted?: string };
  creationTime?: { timestamp?: string; formatted?: string };
  geoData?: { latitude?: number; longitude?: number; altitude?: number };
  geoDataExif?: { latitude?: number; longitude?: number; altitude?: number };
  people?: Array<{ name?: string }>;
}

function humanizeFilename(filename: string): string {
  const base = path.basename(filename, path.extname(filename));
  const cleaned = base
    .replace(/^(IMG|PXL|DSC|MVIMG|VID)[_-]?/i, '')
    .replace(/[_-]+/g, ' ')
    .trim();
  if (!cleaned || /^\d{8}\s?\d{4,}$/.test(cleaned)) {
    return `Captured Moment`;
  }
  return cleaned
    .split(/\s+/)
    .slice(0, 6)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

function inferPlaceFromCoords(lat?: number, lng?: number): string {
  if (typeof lat !== 'number' || typeof lng !== 'number' || (lat === 0 && lng === 0)) {
    return 'Unmapped Place';
  }
  // Quick lightweight offline region/city approximation for instant labeling before Gemini enrichment
  const landmarks: Array<{ name: string; lat: number; lng: number; radiusDeg: number }> = [
    { name: 'San Francisco Bay, USA', lat: 37.77, lng: -122.42, radiusDeg: 1.5 },
    { name: 'Los Angeles, USA', lat: 34.05, lng: -118.24, radiusDeg: 1.5 },
    { name: 'New York, USA', lat: 40.71, lng: -74.0, radiusDeg: 1.5 },
    { name: 'London, UK', lat: 51.51, lng: -0.13, radiusDeg: 1.2 },
    { name: 'Paris, France', lat: 48.86, lng: 2.35, radiusDeg: 1.2 },
    { name: 'Tokyo, Japan', lat: 35.68, lng: 139.76, radiusDeg: 1.5 },
    { name: 'Kyoto, Japan', lat: 35.01, lng: 135.77, radiusDeg: 1.0 },
    { name: 'Lisbon, Portugal', lat: 38.72, lng: -9.14, radiusDeg: 1.0 },
    { name: 'Rome, Italy', lat: 41.9, lng: 12.5, radiusDeg: 1.2 },
    { name: 'Berlin, Germany', lat: 52.52, lng: 13.4, radiusDeg: 1.2 },
    { name: 'Amsterdam, Netherlands', lat: 52.37, lng: 4.9, radiusDeg: 1.0 },
    { name: 'Zurich, Switzerland', lat: 47.37, lng: 8.54, radiusDeg: 1.2 },
    { name: 'Sydney, Australia', lat: -33.87, lng: 151.21, radiusDeg: 1.5 },
    { name: 'Reykjavik, Iceland', lat: 64.15, lng: -21.94, radiusDeg: 2.0 },
  ];
  for (const lm of landmarks) {
    if (Math.hypot(lat - lm.lat, lng - lm.lng) <= lm.radiusDeg) {
      return lm.name;
    }
  }
  const ns = lat >= 0 ? 'N' : 'S';
  const ew = lng >= 0 ? 'E' : 'W';
  return `${Math.abs(lat).toFixed(1)}°${ns}, ${Math.abs(lng).toFixed(1)}°${ew}`;
}

function inferEventFromFolderAndDate(folderName: string, timestamp: number): string {
  const clean = folderName.trim();
  const generic = /^(google photos|photos from \d{4}|takeout|archive|uploads|camera|dcim|downloads|\d{4})$/i;
  if (clean && !generic.test(clean)) {
    return clean;
  }
  const d = new Date(timestamp);
  if (Number.isNaN(d.getTime())) return 'Collected Memories';
  return d.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
}

function inferBasicThemes(timestamp: number, folderName: string, lat?: number): string[] {
  const themes: string[] = [];
  const d = new Date(timestamp);
  if (!Number.isNaN(d.getTime())) {
    const hour = d.getHours();
    if (hour >= 5 && hour <= 8) themes.push('Quiet Mornings');
    else if (hour >= 17 && hour <= 20) themes.push('Golden Hour');
    else if (hour >= 21 || hour <= 4) themes.push('Night Lights');

    const month = d.getMonth();
    if (month >= 5 && month <= 7) themes.push('Summer Sun');
    else if (month === 11 || month <= 1) themes.push('Winter Days');
  }
  if (typeof lat === 'number' && lat !== 0) {
    themes.push('Mapped Moments');
  }
  if (/trip|vacation|travel|holiday|alps|japan|italy|beach/i.test(folderName)) {
    themes.push('Journeys');
  }
  if (/family|birthday|wedding|christmas|thanksgiving/i.test(folderName)) {
    themes.push('Family Moments');
  }
  return Array.from(new Set(themes.length > 0 ? themes : ['Everyday Life']));
}

async function findTakeoutSidecar(imagePath: string): Promise<TakeoutMetadata | null> {
  const dir = path.dirname(imagePath);
  const base = path.basename(imagePath);
  const noExt = path.basename(imagePath, path.extname(imagePath));

  // Google Takeout uses several JSON naming conventions (including 46-char truncation and .supplemental-metadata.json)
  const candidates = [
    `${base}.json`,
    `${base}.supplemental-metadata.json`,
    `${base}.supplemental-metadat.json`,
    `${noExt}.json`,
    `${base.slice(0, 46)}.json`,
    `${base.slice(0, 46)}.supplemental-metadata.json`,
  ];

  for (const cand of candidates) {
    const full = path.join(dir, cand);
    try {
      const raw = await fs.readFile(full, 'utf-8');
      return JSON.parse(raw) as TakeoutMetadata;
    } catch {
      // try next candidate
    }
  }
  return null;
}

export async function parseSinglePhoto(
  imagePath: string,
  options?: {
    overrideSidecar?: TakeoutMetadata | null;
    folderLabel?: string;
    source?: 'takeout' | 'upload';
  }
): Promise<RawMemoryInput> {
  const stat = await fs.stat(imagePath);
  const fileBuffer = await fs.readFile(imagePath);
  const contentHash = crypto.createHash('sha256').update(fileBuffer).digest('hex');
  const sidecar = options?.overrideSidecar ?? (await findTakeoutSidecar(imagePath));

  let exifData: Record<string, unknown> | null = null;
  try {
    exifData = (await exifr.parse(fileBuffer, {
      gps: true,
      pick: ['DateTimeOriginal', 'CreateDate', 'latitude', 'longitude', 'ImageDescription'],
    })) as Record<string, unknown> | null;
  } catch {
    exifData = null;
  }

  // Timestamp resolution: Takeout photoTakenTime -> EXIF DateTimeOriginal -> file mtime
  let timestamp = stat.mtimeMs;
  if (sidecar?.photoTakenTime?.timestamp) {
    const parsed = Number(sidecar.photoTakenTime.timestamp) * 1000;
    if (!Number.isNaN(parsed) && parsed > 0) timestamp = parsed;
  } else if (exifData?.DateTimeOriginal instanceof Date) {
    timestamp = exifData.DateTimeOriginal.getTime();
  } else if (exifData?.CreateDate instanceof Date) {
    timestamp = exifData.CreateDate.getTime();
  } else if (sidecar?.creationTime?.timestamp) {
    const parsed = Number(sidecar.creationTime.timestamp) * 1000;
    if (!Number.isNaN(parsed) && parsed > 0) timestamp = parsed;
  }

  // GPS resolution: Takeout geoData -> Takeout geoDataExif -> EXIF GPS
  let lat: number | undefined;
  let lng: number | undefined;
  const geo = sidecar?.geoData;
  const geoExif = sidecar?.geoDataExif;
  if (geo && (geo.latitude || geo.longitude)) {
    lat = geo.latitude;
    lng = geo.longitude;
  } else if (geoExif && (geoExif.latitude || geoExif.longitude)) {
    lat = geoExif.latitude;
    lng = geoExif.longitude;
  } else if (typeof exifData?.latitude === 'number' && typeof exifData?.longitude === 'number') {
    lat = exifData.latitude;
    lng = exifData.longitude;
  }

  const people = (sidecar?.people ?? [])
    .map((p) => p.name?.trim() ?? '')
    .filter(Boolean);

  const folderName = options?.folderLabel ?? path.basename(path.dirname(imagePath));
  const titleFromFile = humanizeFilename(sidecar?.title || path.basename(imagePath));
  const description =
    sidecar?.description?.trim() ||
    (typeof exifData?.ImageDescription === 'string' ? exifData.ImageDescription.trim() : '') ||
    `Imported from ${folderName}`;

  const id = `mem-${contentHash.slice(0, 12)}`;
  const locationName = inferPlaceFromCoords(lat, lng);
  const event = inferEventFromFolderAndDate(folderName, timestamp);
  const themes = inferBasicThemes(timestamp, folderName, lat);

  return {
    id,
    title: titleFromFile === 'Captured Moment' ? `${event} Moment` : titleFromFile,
    caption: description,
    timestamp,
    locationName,
    lat,
    lng,
    people,
    event,
    themes,
    mood: 'Captured',
    imageUrl: `/api/media/${id}`,
    filePath: imagePath,
    contentHash,
    source: options?.source ?? 'takeout',
    enriched: false,
  };
}

export async function scanTakeoutFolder(
  rootFolder: string,
  maxPhotos = 400
): Promise<{ memories: RawMemoryInput[]; scannedFiles: number; matchedSidecars: number }> {
  const resolvedRoot = path.resolve(rootFolder);
  const rootStat = await fs.stat(resolvedRoot);
  if (!rootStat.isDirectory()) {
    throw new Error(`Path is not a directory: ${resolvedRoot}`);
  }

  const imageFiles: string[] = [];

  async function walk(dir: string): Promise<void> {
    if (imageFiles.length >= maxPhotos) return;
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (imageFiles.length >= maxPhotos) break;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
        await walk(fullPath);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (IMAGE_EXTENSIONS.has(ext)) {
          imageFiles.push(fullPath);
        }
      }
    }
  }

  await walk(resolvedRoot);

  const memories: RawMemoryInput[] = [];
  let matchedSidecars = 0;

  for (const file of imageFiles) {
    const sidecar = await findTakeoutSidecar(file);
    if (sidecar) matchedSidecars++;
    const mem = await parseSinglePhoto(file, {
      overrideSidecar: sidecar,
      source: 'takeout',
    });
    memories.push(mem);
  }

  return {
    memories,
    scannedFiles: imageFiles.length,
    matchedSidecars,
  };
}
