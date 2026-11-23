import type { RawMemoryInput } from '../shared/types.ts';

export interface MergeImportResult {
  memories: RawMemoryInput[];
  added: number;
  skipped: number;
  totalScanned: number;
  duplicateFilePaths: string[];
}

function getDedupeKey(memory: RawMemoryInput): string {
  if (memory.contentHash) return `sha256:${memory.contentHash}`;
  return `id:${memory.id}`;
}

/**
 * Consistent duplicate policy shared by folder import and multipart upload routes.
 * - Matches duplicates primarily by image SHA-256 contentHash, falling back to memory id.
 * - Deduplicates both against existing non-demo memories (when append=true) and within the incoming batch.
 * - Returns separate added/skipped counts plus file paths of any skipped incoming entries (for upload cleanup).
 */
export function mergeImportedMemories(
  existing: RawMemoryInput[],
  incoming: RawMemoryInput[],
  options: { append: boolean }
): MergeImportResult {
  const base = options.append ? existing.filter((m) => m.source !== 'demo') : [];

  const seenKeys = new Set<string>();
  const seenIds = new Set<string>();
  for (const mem of base) {
    seenKeys.add(getDedupeKey(mem));
    seenIds.add(mem.id);
  }

  const addedList: RawMemoryInput[] = [];
  const duplicateFilePaths: string[] = [];
  let skipped = 0;

  for (const mem of incoming) {
    const key = getDedupeKey(mem);
    if (seenKeys.has(key) || seenIds.has(mem.id)) {
      skipped++;
      if (mem.filePath) duplicateFilePaths.push(mem.filePath);
      continue;
    }
    seenKeys.add(key);
    seenIds.add(mem.id);
    addedList.push(mem);
  }

  return {
    memories: [...base, ...addedList],
    added: addedList.length,
    skipped,
    totalScanned: incoming.length,
    duplicateFilePaths,
  };
}
