import { promises as fsp } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { roots, type CategoryId } from "./categories";
import { classify } from "./classify";
import type { Item } from "./scan";

export type Clearable = Extract<CategoryId, "caches" | "trash">;

export interface CleanProgress {
  /** Path that was just handled. */
  path: string;
  /** Bytes it freed; 0 when it could not be removed. */
  freed: number;
}

export interface CleanOptions {
  /** Go through the motions without deleting anything. */
  dryRun?: boolean;
  onProgress?: (progress: CleanProgress) => void;
  home?: string;
}

export interface CleanResult {
  freed: number;
  removed: number;
  /** Paths that could not be removed (in use, or protected by macOS). */
  skipped: string[];
}

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

/**
 * Everything directly inside the category's folders that is safe to clear in
 * one go: the things that would be removed. Costly caches (downloaded models,
 * test browsers) are left for the user to remove one by one. Sizes come from
 * the scan where it measured them.
 */
export async function plan(category: Clearable, known: Item[], home: string = homedir()): Promise<Item[]> {
  const sizes = new Map(known.map((item) => [item.path, item.size]));
  const all = roots(home);
  const rootPaths = new Set(all.map((r) => r.path));
  const items: Item[] = [];
  for (const root of all) {
    if (root.category !== category) continue;
    let names: string[];
    try {
      names = await fsp.readdir(root.path);
    } catch {
      continue;
    }
    for (const name of names) {
      const path = join(root.path, name);
      if (rootPaths.has(path)) continue;
      if (classify({ path, size: 0 }, category).verdict !== "junk") continue;
      let bytes = sizes.get(path);
      if (bytes === undefined) {
        try {
          bytes = (await fsp.lstat(path)).blocks * 512;
        } catch {
          continue;
        }
      }
      items.push({ path, size: bytes });
    }
  }
  return items.sort((a, b) => b.size - a.size);
}

/**
 * What clearing the whole category would remove: its measured size, less the
 * items the clear skips (costly caches, labeled unused rather than junk).
 */
export function clearableSize(category: Clearable, size: number, items: Item[]): number {
  const kept = items.filter((item) => classify(item, category).verdict !== "junk").reduce((sum, item) => sum + item.size, 0);
  return Math.max(0, size - kept);
}

/** True only for a path strictly inside one of the category's own folders. */
function inside(category: Clearable, path: string, home: string): boolean {
  const target = resolve(path);
  return roots(home).some((root) => root.category === category && target.startsWith(resolve(root.path) + sep));
}

export async function clean(category: Clearable, items: Item[], options: CleanOptions = {}): Promise<CleanResult> {
  const home = options.home ?? homedir();
  const result: CleanResult = { freed: 0, removed: 0, skipped: [] };

  for (const item of items) {
    let freed = 0;
    if (!inside(category, item.path, home)) {
      result.skipped.push(item.path);
    } else if (options.dryRun) {
      await sleep(25 + Math.min(120, item.size / 2e7));
      freed = item.size;
    } else {
      try {
        await fsp.rm(item.path, { recursive: true, force: true });
        freed = item.size;
      } catch {
        // In use or protected. Whatever was removed before the failure is
        // picked up when the category is measured again afterwards.
        result.skipped.push(item.path);
      }
    }
    if (freed > 0) {
      result.freed += freed;
      result.removed += 1;
    }
    options.onProgress?.({ path: item.path, freed });
  }
  return result;
}
