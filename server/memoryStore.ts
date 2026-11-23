import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import type { RawMemoryInput, StorageHealthState, StorageRecoveryInfo } from '../shared/types.ts';

export interface MemoryStoreOptions {
  storePath: string;
  demoMemories: RawMemoryInput[];
}

export interface LoadResult {
  state: StorageHealthState;
  memories: RawMemoryInput[];
  recovery: StorageRecoveryInfo | null;
}

function isValidMemoryItem(value: unknown): value is RawMemoryInput {
  if (!value || typeof value !== 'object') return false;
  const obj = value as Record<string, unknown>;
  return (
    typeof obj.id === 'string' &&
    obj.id.length > 0 &&
    typeof obj.title === 'string' &&
    typeof obj.timestamp === 'number' &&
    Array.isArray(obj.people) &&
    Array.isArray(obj.themes)
  );
}

function isValidMemoryList(value: unknown): value is RawMemoryInput[] {
  return Array.isArray(value) && value.length > 0 && value.every(isValidMemoryItem);
}

function isErrno(err: unknown, code: string): boolean {
  return Boolean(err && typeof err === 'object' && 'code' in err && (err as { code?: string }).code === code);
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Atomic file rename with brief retry for transient Windows AV/indexer locks (EPERM/EBUSY).
 */
async function atomicRename(src: string, dest: string): Promise<void> {
  const maxAttempts = 5;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await fs.rename(src, dest);
      return;
    } catch (err) {
      if (attempt < maxAttempts && (isErrno(err, 'EPERM') || isErrno(err, 'EBUSY'))) {
        await sleep(25 * attempt);
        continue;
      }
      throw err;
    }
  }
}

export class MemoryStore {
  private readonly storePath: string;
  private readonly demoMemories: RawMemoryInput[];
  private memories: RawMemoryInput[];
  private state: StorageHealthState = 'demo';
  private recovery: StorageRecoveryInfo | null = null;
  private revision = 0;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(options: MemoryStoreOptions) {
    this.storePath = path.resolve(options.storePath);
    this.demoMemories = options.demoMemories;
    this.memories = [...options.demoMemories];
  }

  public getStorePath(): string {
    return this.storePath;
  }

  public getMemories(): RawMemoryInput[] {
    return this.memories;
  }

  public getState(): StorageHealthState {
    return this.state;
  }

  public getRecovery(): StorageRecoveryInfo | null {
    return this.recovery;
  }

  public getRevision(): number {
    return this.revision;
  }

  /**
   * Loads the saved photo index from disk.
   * - ENOENT (first launch): cleanly uses demo memories with state = 'demo'.
   * - Damaged JSON / schema mismatch / read failure: preserves the damaged file untouched on disk,
   *   falls back to read-only demo view, and surfaces structured recovery details.
   */
  public async load(): Promise<LoadResult> {
    await fs.mkdir(path.dirname(this.storePath), { recursive: true });

    let rawText: string;
    try {
      rawText = await fs.readFile(this.storePath, 'utf-8');
    } catch (err) {
      if (isErrno(err, 'ENOENT')) {
        this.memories = [...this.demoMemories];
        this.state = 'demo';
        this.recovery = null;
        this.revision++;
        return { state: this.state, memories: this.memories, recovery: null };
      }

      const detail = err instanceof Error ? err.message : String(err);
      this.memories = [...this.demoMemories];
      this.state = 'damaged';
      this.recovery = {
        code: 'READ_ERROR',
        message:
          'Could not read your saved photo index. The file on disk was left untouched so you can inspect or recover it.',
        damagedPath: this.storePath,
        detail,
        detectedAt: new Date().toISOString(),
      };
      this.revision++;
      return { state: this.state, memories: this.memories, recovery: this.recovery };
    }

    try {
      const parsed: unknown = JSON.parse(rawText);
      if (!isValidMemoryList(parsed)) {
        throw new Error('Photo index must be a non-empty JSON array of valid memory records.');
      }

      let backfilledCount = 0;
      const hydrated: RawMemoryInput[] = [];
      for (const mem of parsed) {
        if (!mem.contentHash && mem.filePath) {
          try {
            const buf = await fs.readFile(mem.filePath);
            const contentHash = crypto.createHash('sha256').update(buf).digest('hex');
            hydrated.push({ ...mem, contentHash });
            backfilledCount++;
            continue;
          } catch {
            // Photo file is missing/unreadable; keep the legacy record untouched
          }
        }
        hydrated.push(mem);
      }

      this.memories = hydrated;
      this.state = 'loaded';
      this.recovery = null;
      this.revision++;

      if (backfilledCount > 0) {
        try {
          await this.save(hydrated);
        } catch {
          // Keep in-memory backfilled hashes even if disk is temporarily read-only
        }
      }

      return { state: this.state, memories: this.memories, recovery: null };
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      this.memories = [...this.demoMemories];
      this.state = 'damaged';
      this.recovery = {
        code: 'DAMAGED_INDEX',
        message:
          'Your saved photo index is damaged (for example after an interrupted save) and has been preserved untouched on disk. Repair it manually or archive & start fresh.',
        damagedPath: this.storePath,
        detail,
        detectedAt: new Date().toISOString(),
      };
      this.revision++;
      return { state: this.state, memories: this.memories, recovery: this.recovery };
    }
  }

  /**
   * Preserves a damaged index file under a timestamped backup name before any destructive operation.
   */
  private async archiveDamagedIndexIfNeeded(): Promise<string | undefined> {
    if (this.state !== 'damaged') return undefined;
    try {
      await fs.access(this.storePath);
    } catch {
      return undefined;
    }

    const dir = path.dirname(this.storePath);
    const ext = path.extname(this.storePath) || '.json';
    const base = path.basename(this.storePath, ext);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const archivePath = path.join(dir, `${base}.damaged.${stamp}${ext}`);
    await fs.copyFile(this.storePath, archivePath);
    return archivePath;
  }

  /**
   * Atomically persists memories by writing to a temp file in the same directory,
   * fsyncing to disk, and atomically renaming into place.
   */
  public async save(nextMemories: RawMemoryInput[]): Promise<{ archivedDamagedPath?: string }> {
    let result: { archivedDamagedPath?: string } = {};

    const task = this.writeChain.then(async () => {
      const dir = path.dirname(this.storePath);
      await fs.mkdir(dir, { recursive: true });

      const archivedDamagedPath = await this.archiveDamagedIndexIfNeeded();
      const payload = JSON.stringify(nextMemories, null, 2);
      const unique = `${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2, 8)}`;
      const tmpPath = path.join(dir, `.${path.basename(this.storePath)}.${unique}.tmp`);

      let handle: fs.FileHandle | null = null;
      try {
        handle = await fs.open(tmpPath, 'w');
        await handle.writeFile(payload, 'utf-8');
        await handle.sync();
        await handle.close();
        handle = null;

        await atomicRename(tmpPath, this.storePath);
      } catch (err) {
        if (handle) {
          try {
            await handle.close();
          } catch {
            // ignore secondary close failure
          }
        }
        try {
          await fs.unlink(tmpPath);
        } catch {
          // ignore cleanup failure if temp file was never created
        }
        throw err;
      }

      this.memories = nextMemories;
      this.state = 'loaded';
      this.recovery = null;
      this.revision++;
      result = { archivedDamagedPath };
    });

    // Keep queue usable even if one write throws
    this.writeChain = task.catch(() => {});
    await task;
    return result;
  }

  /**
   * Resets to the demo dataset. If the index on disk was damaged, archives it first so data is never silently lost.
   */
  public async resetToDemo(): Promise<{ archivedDamagedPath?: string }> {
    let result: { archivedDamagedPath?: string } = {};

    const task = this.writeChain.then(async () => {
      const archivedDamagedPath = await this.archiveDamagedIndexIfNeeded();
      try {
        await fs.unlink(this.storePath);
      } catch (err) {
        if (!isErrno(err, 'ENOENT')) throw err;
      }
      this.memories = [...this.demoMemories];
      this.state = 'demo';
      this.recovery = null;
      this.revision++;
      result = { archivedDamagedPath };
    });

    this.writeChain = task.catch(() => {});
    await task;
    return result;
  }
}
