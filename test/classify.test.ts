import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { test } from "node:test";
import { classify } from "../src/core/classify";
import { clearableSize, plan } from "../src/core/clean";

const DAY = 24 * 3600 * 1000;
const now = Date.UTC(2026, 10, 16);
const twoYearsAgo = now - 730 * DAY;

test("a folder is not called unused on its modification time alone", () => {
  // An active project whose files change while the folder's own entries don't.
  const project = { path: "/Users/someone/code/app", size: 1, dir: true };
  const label = classify(project, "documents", { at: twoYearsAgo, kind: "changed" }, now);
  assert.equal(label.verdict, "yours");
  assert.match(label.reason, /changed 2 years ago/);
});

test("files, and folders Spotlight saw opened, are still called unused when idle", () => {
  const file = { path: "/Users/someone/Documents/old.key", size: 1, dir: false };
  assert.equal(classify(file, "documents", { at: twoYearsAgo, kind: "changed" }, now).verdict, "unused");
  const app = { path: "/Applications/Old.app", size: 1, dir: true };
  assert.equal(classify(app, "apps", { at: twoYearsAgo, kind: "opened" }, now).verdict, "unused");
});

test("only virtualenv names are called python environments", () => {
  assert.match(classify({ path: "/Users/someone/code/app/.venv", size: 1, dir: true }, "documents").reason, /python/);
  assert.doesNotMatch(classify({ path: "/Users/someone/code/app/env", size: 1, dir: true }, "documents").reason, /python/);
});

test("clearing all caches skips the ones that are costly to lose", async () => {
  const fake = mkdtempSync(join(tmpdir(), "fix-storage-test-"));
  try {
    for (const dir of [".cache/huggingface", ".cache/pip", "Library/Caches/ms-playwright", "Library/Caches/com.example.app"]) {
      mkdirSync(join(fake, dir), { recursive: true });
      writeFileSync(join(fake, dir, "blob"), "x");
    }
    const names = (await plan("caches", [], fake)).map((item) => basename(item.path)).sort();
    assert.deepEqual(names, ["com.example.app", "pip"]);
    assert.equal(classify({ path: join(fake, ".cache/huggingface"), size: 1 }, "caches").verdict, "unused");
  } finally {
    rmSync(fake, { recursive: true, force: true });
  }
});

test("the size offered for clearing leaves out the caches the clear skips", () => {
  const items = [
    { path: "/Users/someone/.cache/huggingface", size: 20, dir: true },
    { path: "/Users/someone/Library/Caches/com.example.app", size: 3, dir: true },
  ];
  assert.equal(clearableSize("caches", 23, items), 3);
  assert.equal(clearableSize("trash", 23, items), 23);
});

test("a cache folder named like a built-in object property is still plain junk", () => {
  for (const name of ["constructor", "toString", "__proto__"]) {
    const label = classify({ path: `/Users/someone/Library/Caches/${name}`, size: 1, dir: true }, "caches");
    assert.equal(label.verdict, "junk", name);
    assert.equal(typeof label.reason, "string");
  }
});
