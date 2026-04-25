/**
 * Unit tests for the deterministic transform layer.
 *
 * Each test spins up a tmp directory with a single file, exercises
 * one transform, and asserts:
 *   - the right shape was produced (applied vs skipped + reasonCode)
 *   - exports are preserved
 *   - the file content changed in the expected minimal way
 *
 * No model calls. No coordinator. These are the lowest-level tests.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  detectRouteFramework,
  findExistingRoutes,
  tryAddRoute,
  tryAddImport,
  tryAddNamedExport,
  tryAddObjectProperty,
} from "./index.js";

function withTempFile(content: string): { dir: string; file: string; abs: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "aedis-transform-"));
  const rel = "src/target.ts";
  const abs = join(dir, rel);
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(abs, content, "utf-8");
  return { dir, file: rel, abs, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const FASTIFY_SERVER = `
import Fastify from "fastify";

const fastify = Fastify({ logger: true });

fastify.get("/", async (_request, reply) => {
  return { ok: true };
});

fastify.get("/health", async () => ({ status: "ok" }));

export const port = 18797;

export async function startServer() {
  await fastify.listen({ port });
}
`.trimStart();

const EXPRESS_APP = `
import express from "express";

const app = express();

app.get("/", (req, res) => {
  res.json({ ok: true });
});

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

export const port = 3000;
export function start() {
  app.listen(port);
}
`.trimStart();

const EXPRESS_ROUTER = `
import { Router } from "express";

const router = Router();

router.get("/", (_req, res) => {
  res.json({ ok: true });
});

router.post("/login", (req, res) => {
  res.json({ token: "fake" });
});

export default router;
export { router as routes };
`.trimStart();

// ─── Detection ─────────────────────────────────────────────────────

test("transforms: detectRouteFramework picks fastify for fastify-imported files", () => {
  const d = detectRouteFramework(FASTIFY_SERVER);
  assert.equal(d.framework, "fastify");
  assert.equal(d.bindingName, "fastify");
});

test("transforms: detectRouteFramework picks express-router on `router.get(`", () => {
  const d = detectRouteFramework(EXPRESS_ROUTER);
  assert.equal(d.framework, "express-router");
  assert.equal(d.bindingName, "router");
});

test("transforms: detectRouteFramework picks express-app on app.get with express import", () => {
  const d = detectRouteFramework(EXPRESS_APP);
  assert.equal(d.framework, "express-app");
  assert.equal(d.bindingName, "app");
});

test("transforms: findExistingRoutes returns 2 routes on Fastify fixture", () => {
  const d = detectRouteFramework(FASTIFY_SERVER);
  const sites = findExistingRoutes(FASTIFY_SERVER, d.bindingName!);
  assert.equal(sites.length, 2);
  assert.equal(sites[0].path, "/");
  assert.equal(sites[1].path, "/health");
  assert.equal(sites[1].method, "GET");
});

// ─── Route insertion ──────────────────────────────────────────────

test("tryAddRoute: Fastify — inserts /models endpoint after last existing route, preserves exports", async () => {
  const t = withTempFile(FASTIFY_SERVER);
  try {
    const result = await tryAddRoute({
      projectRoot: t.dir, file: t.file,
      method: "GET", path: "/models",
    });
    assert.equal(result.kind, "applied");
    if (result.kind === "applied") {
      assert.match(result.updatedContent, /fastify\.get\("\/models"/);
      assert.equal(result.exportDiff.missing.length, 0);
      // Original 2 exports should still be present.
      assert.ok(result.exportDiff.proposed.includes("port"));
      assert.ok(result.exportDiff.proposed.includes("startServer"));
      // No new exports — route adds don't add named exports.
      assert.deepEqual([...result.exportDiff.added], []);
    }
  } finally { t.cleanup(); }
});

test("tryAddRoute: Express app — inserts after last app.get in matching style", async () => {
  const t = withTempFile(EXPRESS_APP);
  try {
    const result = await tryAddRoute({
      projectRoot: t.dir, file: t.file,
      method: "POST", path: "/echo",
    });
    assert.equal(result.kind, "applied");
    if (result.kind === "applied") {
      assert.match(result.updatedContent, /app\.post\("\/echo"/);
      // Express inserter should use res.json shape, not Fastify reply.
      assert.match(result.updatedContent, /res\.json/);
      assert.deepEqual([...result.exportDiff.missing], []);
    }
  } finally { t.cleanup(); }
});

test("tryAddRoute: Express router — inserts on router binding", async () => {
  const t = withTempFile(EXPRESS_ROUTER);
  try {
    const result = await tryAddRoute({
      projectRoot: t.dir, file: t.file,
      method: "GET", path: "/me",
    });
    assert.equal(result.kind, "applied");
    if (result.kind === "applied") {
      assert.match(result.updatedContent, /router\.get\("\/me"/);
    }
  } finally { t.cleanup(); }
});

test("tryAddRoute: refuses when route already exists (duplicate)", async () => {
  const t = withTempFile(FASTIFY_SERVER);
  try {
    const result = await tryAddRoute({
      projectRoot: t.dir, file: t.file,
      method: "GET", path: "/health",
    });
    assert.equal(result.kind, "skipped");
    if (result.kind === "skipped") {
      assert.equal(result.reasonCode, "duplicate");
    }
  } finally { t.cleanup(); }
});

test("tryAddRoute: refuses on file with no recognizable routes", async () => {
  const noRoutes = `export const x = 1;\nexport function helper() { return x; }\n`;
  const t = withTempFile(noRoutes);
  try {
    const result = await tryAddRoute({
      projectRoot: t.dir, file: t.file,
      method: "GET", path: "/anything",
    });
    assert.equal(result.kind, "skipped");
    if (result.kind === "skipped") {
      assert.equal(result.reasonCode, "not-recognizable");
    }
  } finally { t.cleanup(); }
});

test("tryAddRoute: refuses when target file is missing", async () => {
  const t = withTempFile(FASTIFY_SERVER);
  try {
    const result = await tryAddRoute({
      projectRoot: t.dir, file: "src/does-not-exist.ts",
      method: "GET", path: "/x",
    });
    assert.equal(result.kind, "skipped");
    if (result.kind === "skipped") {
      assert.equal(result.reasonCode, "file-missing");
    }
  } finally { t.cleanup(); }
});

test("tryAddRoute: produces a unified diff in the receipt payload", async () => {
  const t = withTempFile(FASTIFY_SERVER);
  try {
    const result = await tryAddRoute({
      projectRoot: t.dir, file: t.file,
      method: "GET", path: "/models",
    });
    assert.equal(result.kind, "applied");
    if (result.kind === "applied") {
      assert.match(result.diff, /^--- a\//m);
      assert.match(result.diff, /^\+\+\+ b\//m);
      assert.match(result.diff, /\+.*\/models/);
    }
  } finally { t.cleanup(); }
});

// ─── Imports ──────────────────────────────────────────────────────

test("tryAddImport: extends an existing { … } import without duplicating", async () => {
  const src = `import { foo, bar } from "./util.js";\nimport Fastify from "fastify";\nexport const x = 1;\n`;
  const t = withTempFile(src);
  try {
    const r = await tryAddImport({
      projectRoot: t.dir, file: t.file,
      specifier: "./util.js", names: ["bar", "baz"],
    });
    assert.equal(r.kind, "applied");
    if (r.kind === "applied") {
      assert.match(r.updatedContent, /import\s+\{\s*foo,\s*bar,\s*baz\s*\}\s*from/);
      // Existing other imports untouched
      assert.match(r.updatedContent, /import Fastify from "fastify"/);
    }
  } finally { t.cleanup(); }
});

test("tryAddImport: refuses to mix with default-only existing import", async () => {
  const src = `import util from "./util.js";\nexport const x = 1;\n`;
  const t = withTempFile(src);
  try {
    const r = await tryAddImport({
      projectRoot: t.dir, file: t.file,
      specifier: "./util.js", names: ["foo"],
    });
    assert.equal(r.kind, "skipped");
    if (r.kind === "skipped") {
      assert.equal(r.reasonCode, "unsupported-shape");
    }
  } finally { t.cleanup(); }
});

test("tryAddImport: adds fresh import after the last existing import", async () => {
  const src = `import { a } from "./a.js";\nimport { b } from "./b.js";\nexport const x = 1;\n`;
  const t = withTempFile(src);
  try {
    const r = await tryAddImport({
      projectRoot: t.dir, file: t.file,
      specifier: "./c.js", names: ["c"],
    });
    assert.equal(r.kind, "applied");
    if (r.kind === "applied") {
      const lines = r.updatedContent.split("\n");
      const cIdx = lines.findIndex((l) => /from "\.\/c\.js"/.test(l));
      const bIdx = lines.findIndex((l) => /from "\.\/b\.js"/.test(l));
      assert.ok(cIdx > bIdx, "fresh import should land after the last existing import");
    }
  } finally { t.cleanup(); }
});

test("tryAddImport: refuses when ALL requested names already imported", async () => {
  const src = `import { foo } from "./util.js";\nexport const x = 1;\n`;
  const t = withTempFile(src);
  try {
    const r = await tryAddImport({
      projectRoot: t.dir, file: t.file,
      specifier: "./util.js", names: ["foo"],
    });
    assert.equal(r.kind, "skipped");
    if (r.kind === "skipped") assert.equal(r.reasonCode, "duplicate");
  } finally { t.cleanup(); }
});

// ─── Named export append ──────────────────────────────────────────

test("tryAddNamedExport: appends a new export const at end of file", async () => {
  const src = `export const a = 1;\nexport const b = 2;\n`;
  const t = withTempFile(src);
  try {
    const r = await tryAddNamedExport({
      projectRoot: t.dir, file: t.file,
      name: "c",
      declaration: "export const c = 3;",
    });
    assert.equal(r.kind, "applied");
    if (r.kind === "applied") {
      assert.match(r.updatedContent, /export const c = 3;/);
      assert.deepEqual([...r.exportDiff.added], ["c"]);
      assert.deepEqual([...r.exportDiff.missing], []);
    }
  } finally { t.cleanup(); }
});

test("tryAddNamedExport: refuses when name already exported", async () => {
  const src = `export const c = 3;\n`;
  const t = withTempFile(src);
  try {
    const r = await tryAddNamedExport({
      projectRoot: t.dir, file: t.file,
      name: "c",
      declaration: "export const c = 5;",
    });
    assert.equal(r.kind, "skipped");
    if (r.kind === "skipped") assert.equal(r.reasonCode, "duplicate");
  } finally { t.cleanup(); }
});

test("tryAddNamedExport: refuses if declaration's name disagrees with the input name", async () => {
  const src = `export const a = 1;\n`;
  const t = withTempFile(src);
  try {
    const r = await tryAddNamedExport({
      projectRoot: t.dir, file: t.file,
      name: "b",
      declaration: "export const c = 5;", // declares 'c', not 'b'
    });
    assert.equal(r.kind, "skipped");
    if (r.kind === "skipped") assert.equal(r.reasonCode, "unsupported-shape");
  } finally { t.cleanup(); }
});

// ─── Object property add ──────────────────────────────────────────

test("tryAddObjectProperty: adds a key to a recognized object literal", async () => {
  const src = `export const config = {\n  timeout: 1000,\n  retries: 3,\n};\n`;
  const t = withTempFile(src);
  try {
    const r = await tryAddObjectProperty({
      projectRoot: t.dir, file: t.file,
      objectName: "config",
      propertyKey: "verbose",
      propertyValue: "true",
    });
    assert.equal(r.kind, "applied");
    if (r.kind === "applied") {
      assert.match(r.updatedContent, /verbose:\s*true/);
      // existing keys preserved
      assert.match(r.updatedContent, /timeout:\s*1000/);
      assert.match(r.updatedContent, /retries:\s*3/);
    }
  } finally { t.cleanup(); }
});

test("tryAddObjectProperty: refuses on duplicate key", async () => {
  const src = `export const config = {\n  timeout: 1000,\n};\n`;
  const t = withTempFile(src);
  try {
    const r = await tryAddObjectProperty({
      projectRoot: t.dir, file: t.file,
      objectName: "config",
      propertyKey: "timeout",
      propertyValue: "5000",
    });
    assert.equal(r.kind, "skipped");
    if (r.kind === "skipped") assert.equal(r.reasonCode, "duplicate");
  } finally { t.cleanup(); }
});

test("tryAddObjectProperty: refuses on object containing a spread", async () => {
  const src = `const base = {x: 1};\nexport const config = {\n  ...base,\n  timeout: 1000,\n};\n`;
  const t = withTempFile(src);
  try {
    const r = await tryAddObjectProperty({
      projectRoot: t.dir, file: t.file,
      objectName: "config",
      propertyKey: "verbose",
      propertyValue: "true",
    });
    assert.equal(r.kind, "skipped");
    if (r.kind === "skipped") assert.equal(r.reasonCode, "unsupported-shape");
  } finally { t.cleanup(); }
});

test("tryAddObjectProperty: refuses when object is not in the file", async () => {
  const src = `export const other = {};\n`;
  const t = withTempFile(src);
  try {
    const r = await tryAddObjectProperty({
      projectRoot: t.dir, file: t.file,
      objectName: "config",
      propertyKey: "x",
      propertyValue: "1",
    });
    assert.equal(r.kind, "skipped");
    if (r.kind === "skipped") assert.equal(r.reasonCode, "not-recognizable");
  } finally { t.cleanup(); }
});

// ─── Cross-cutting: no transform writes the file (caller's job) ───

test("transforms: tryAddRoute does NOT write the file — caller is responsible for persistence", async () => {
  const t = withTempFile(FASTIFY_SERVER);
  try {
    await tryAddRoute({
      projectRoot: t.dir, file: t.file,
      method: "GET", path: "/models",
    });
    // The file on disk is unchanged — only the result struct carries the new content.
    const onDisk = readFileSync(t.abs, "utf-8");
    assert.equal(onDisk, FASTIFY_SERVER, "transform must not mutate disk; the deterministic-builder facade does that");
  } finally { t.cleanup(); }
});
