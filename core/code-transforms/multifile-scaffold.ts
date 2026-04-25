import { existsSync, readdirSync, statSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, posix, relative, resolve, sep } from "node:path";
import {
  addNamedImportToContent,
} from "./imports.js";
import {
  tryAddConstructorParamProperty,
  tryAddDecoratedClassMethod,
  tryAddClassMethod,
} from "./class-extend.js";
import {
  buildUnifiedDiff,
  computeExportDelta,
  findMatchingDelimiter,
  validatePostEdit,
} from "./util.js";
import type { AppliedTransform, SkippedTransform, TransformResult } from "./types.js";
import type { FileMutationRoleUpdate } from "../change-set.js";

export interface BackendScaffoldPlan {
  readonly kind: "nestjs-controller-service-dto";
  readonly controllerFile: string;
  readonly controllerClass: string;
  readonly serviceFile: string;
  readonly serviceClass: string;
  readonly serviceProperty: string;
  readonly serviceMethod: string;
  readonly serviceInjectionNeeded: boolean;
  readonly httpMethod: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  readonly routePath: string;
  readonly controllerMethod: string;
  readonly dtoName: string | null;
  readonly dtoFile: string | null;
  readonly dtoAction: "import-existing" | "create-interface" | "none" | "skipped";
}

export type ScaffoldPlanResult =
  | { readonly ok: true; readonly plan: BackendScaffoldPlan }
  | { readonly ok: false; readonly skipped: SkippedTransform };

export interface ScaffoldAppliedResult {
  readonly kind: "applied";
  readonly plan: BackendScaffoldPlan;
  readonly applied: readonly AppliedTransform[];
  readonly skipped: readonly SkippedTransform[];
  readonly targetRoles: readonly FileMutationRoleUpdate[];
}

export type ScaffoldResult = ScaffoldAppliedResult | { readonly kind: "skipped"; readonly skipped: readonly SkippedTransform[]; readonly reason: string };

const HTTP_TO_DECORATOR = {
  GET: "Get",
  POST: "Post",
  PUT: "Put",
  PATCH: "Patch",
  DELETE: "Delete",
} as const;

export async function planBackendScaffold(input: {
  readonly projectRoot: string;
  readonly userRequest: string;
  readonly targetFiles: readonly string[];
}): Promise<ScaffoldPlanResult> {
  const parsed = parseScaffoldPrompt(input.userRequest);
  if (!parsed) {
    return skip("multi-file-scaffold", "(planner)", "not-recognizable", "Prompt is not a supported controller/service scaffold shape.");
  }

  const files = await collectCandidateFiles(input.projectRoot, input.targetFiles);
  const controllerMatches = files.filter((f) => hasClass(f.content, parsed.controllerClass) || /@Controller\s*\(/.test(f.content));
  if (controllerMatches.length !== 1) {
    return skip("multi-file-scaffold", "(planner)", controllerMatches.length === 0 ? "not-recognizable" : "ambiguous", `Expected exactly one controller file for ${parsed.controllerClass}; found ${controllerMatches.length}.`);
  }
  const serviceMatches = files.filter((f) => hasClass(f.content, parsed.serviceClass));
  if (serviceMatches.length !== 1) {
    return skip("multi-file-scaffold", "(planner)", serviceMatches.length === 0 ? "not-recognizable" : "ambiguous", `Expected exactly one service file for ${parsed.serviceClass}; found ${serviceMatches.length}.`);
  }

  const controller = controllerMatches[0];
  const service = serviceMatches[0];
  const controllerClass = hasClass(controller.content, parsed.controllerClass)
    ? parsed.controllerClass
    : findFirstClass(controller.content, /Controller$/);
  if (!controllerClass) {
    return skip("multi-file-scaffold", controller.path, "not-recognizable", "Controller class could not be identified.");
  }
  const serviceProperty = findServiceProperty(controller.content, controllerClass, parsed.serviceClass) ?? lowerFirst(parsed.serviceClass);
  const serviceInjectionNeeded = findServiceProperty(controller.content, controllerClass, parsed.serviceClass) === null;

  const dtoFile = parsed.dtoName ? findDtoFile(files, parsed.dtoName) : null;
  const missingDtoTarget = parsed.dtoName
    ? input.targetFiles.find((target) => !existsSync(resolve(input.projectRoot, target)) && target.toLowerCase().includes(parsed.dtoName!.replace(/Dto$/, "").toLowerCase()))
    : undefined;
  const dtoAction = parsed.dtoName
    ? dtoFile ? "import-existing" : missingDtoTarget ? "create-interface" : "skipped"
    : "none";
  const resolvedDtoFile = dtoFile ?? missingDtoTarget ?? null;

  return {
    ok: true,
    plan: {
      kind: "nestjs-controller-service-dto",
      controllerFile: controller.path,
      controllerClass,
      serviceFile: service.path,
      serviceClass: parsed.serviceClass,
      serviceProperty,
      serviceMethod: parsed.serviceMethod,
      serviceInjectionNeeded,
      httpMethod: parsed.httpMethod,
      routePath: parsed.routePath,
      controllerMethod: parsed.serviceMethod,
      dtoName: parsed.dtoName,
      dtoFile: resolvedDtoFile,
      dtoAction,
    },
  };
}

export async function applyBackendScaffold(input: {
  readonly projectRoot: string;
  readonly userRequest: string;
  readonly targetFiles: readonly string[];
}): Promise<ScaffoldResult> {
  const planned = await planBackendScaffold(input);
  if (!planned.ok) {
    return { kind: "skipped", skipped: [planned.skipped], reason: planned.skipped.reason };
  }
  const plan = planned.plan;
  const applied: AppliedTransform[] = [];
  const skipped: SkippedTransform[] = [];
  const originals = new Map<string, string | null>();

  const rollback = async () => {
    for (const [file, content] of originals) {
      const abs = resolve(input.projectRoot, file);
      if (content !== null) await writeFile(abs, content, "utf-8");
    }
  };

  if (plan.dtoName && plan.dtoAction === "create-interface" && plan.dtoFile) {
    const r = await createDtoInterface(input.projectRoot, plan.dtoFile, plan.dtoName);
    push(applied, skipped, r);
    if (r.kind === "skipped") return fail(skipped);
  } else if (plan.dtoName && plan.dtoAction === "skipped") {
    skipped.push(makeSkip("dto-file-create", plan.dtoFile ?? "(dto)", "not-recognizable", `DTO ${plan.dtoName} was named but no existing or target DTO file was found.`));
    return fail(skipped);
  }

  if (plan.serviceInjectionNeeded) {
    const r = await tryAddConstructorParamProperty({
      projectRoot: input.projectRoot,
      file: plan.controllerFile,
      className: plan.controllerClass,
      paramName: plan.serviceProperty,
      paramType: plan.serviceClass,
      visibility: "private",
      isReadonly: true,
    });
    const imported = r.kind === "applied"
      ? addImportToApplied(input.projectRoot, r, plan.serviceClass, importSpecifier(plan.controllerFile, plan.serviceFile))
      : r;
    push(applied, skipped, imported);
    if (imported.kind === "skipped") return fail(skipped);
    await stageWrite(input.projectRoot, originals, imported.file, imported.updatedContent);
  }

  const controller = await addControllerMethod(input.projectRoot, plan);
  push(applied, skipped, controller);
  if (controller.kind === "skipped") {
    await rollback();
    return fail(skipped);
  }
  await stageWrite(input.projectRoot, originals, controller.file, controller.updatedContent);

  const service = await addServiceMethod(input.projectRoot, plan);
  push(applied, skipped, service);
  if (service.kind === "skipped") {
    await rollback();
    return fail(skipped);
  }
  await stageWrite(input.projectRoot, originals, service.file, service.updatedContent);

  for (const transform of applied) {
    await writeFile(resolve(input.projectRoot, transform.file), transform.updatedContent, "utf-8");
  }
  return { kind: "applied", plan, applied, skipped, targetRoles: scaffoldTargetRoles(input.targetFiles, plan, applied, skipped) };
}

function scaffoldTargetRoles(
  targetFiles: readonly string[],
  plan: BackendScaffoldPlan,
  applied: readonly AppliedTransform[],
  skipped: readonly SkippedTransform[],
): readonly FileMutationRoleUpdate[] {
  const roles = new Map<string, FileMutationRoleUpdate>();
  const appliedFiles = new Set(applied.map((entry) => entry.file));
  const skippedByFile = new Map(skipped.map((entry) => [entry.file, entry]));

  roles.set(plan.controllerFile, {
    path: plan.controllerFile,
    role: "write-required",
    reason: `Controller route method ${plan.controllerClass}.${plan.controllerMethod} must be emitted.`,
  });

  roles.set(plan.serviceFile, {
    path: plan.serviceFile,
    role: "write-required",
    reason: `Service method ${plan.serviceClass}.${plan.serviceMethod} must be emitted.`,
  });

  if (plan.dtoFile) {
    const role = plan.dtoAction === "create-interface" ? "write-required" : "type-reference";
    roles.set(plan.dtoFile, {
      path: plan.dtoFile,
      role,
      reason: role === "write-required"
        ? `DTO ${plan.dtoName ?? "type"} is planned for creation or mutation.`
        : `DTO ${plan.dtoName ?? "type"} is imported/referenced but does not need mutation.`,
    });
  }

  for (const file of targetFiles) {
    if (roles.has(file)) continue;
    const skippedTarget = skippedByFile.get(file);
    roles.set(file, {
      path: file,
      role: skippedTarget ? "skipped-unsupported" : appliedFiles.has(file) ? "write-required" : "read-context",
      reason: skippedTarget?.reason ?? "Target was available as context but was not part of the deterministic scaffold mutation plan.",
    });
  }

  return [...roles.values()];
}

async function stageWrite(
  projectRoot: string,
  originals: Map<string, string | null>,
  file: string,
  content: string,
): Promise<void> {
  const abs = resolve(projectRoot, file);
  if (!originals.has(file)) {
    originals.set(file, existsSync(abs) ? await readFile(abs, "utf-8") : null);
  }
  await writeFile(abs, content, "utf-8");
}

function parseScaffoldPrompt(text: string): {
  httpMethod: BackendScaffoldPlan["httpMethod"];
  routePath: string;
  serviceClass: string;
  serviceMethod: string;
  controllerClass: string;
  dtoName: string | null;
} | null {
  const verbMatch = /\b(GET|POST|PUT|PATCH|DELETE)\b\s+(\/[\w\-/:.]*)/i.exec(text);
  const callMatch = /\b([A-Z][\w$]*Service)\.([A-Za-z_$][\w$]*)\b/.exec(text);
  if (!verbMatch || !callMatch) return null;
  const httpMethod = verbMatch[1].toUpperCase() as BackendScaffoldPlan["httpMethod"];
  const serviceClass = callMatch[1];
  const serviceMethod = callMatch[2];
  const dtoMatch = /\b(?:with|using|body|dto)\s+([A-Z][\w$]*Dto)\b/.exec(text) ?? /\b([A-Z][\w$]*Dto)\b/.exec(text);
  const controllerMatch = /\b([A-Z][\w$]*Controller)\b/.exec(text);
  const controllerClass = controllerMatch?.[1] ?? `${serviceClass.replace(/Service$/, "")}Controller`;
  return {
    httpMethod,
    routePath: verbMatch[2],
    serviceClass,
    serviceMethod,
    controllerClass,
    dtoName: dtoMatch?.[1] ?? null,
  };
}

async function addControllerMethod(projectRoot: string, plan: BackendScaffoldPlan): Promise<TransformResult> {
  const needsBody = !!plan.dtoName && ["POST", "PUT", "PATCH"].includes(plan.httpMethod);
  const parameters = needsBody ? "@Body() body: " + plan.dtoName : "";
  const callArg = needsBody ? "body" : "";
  const body = `return this.${plan.serviceProperty}.${plan.serviceMethod}(${callArg});`;
  const r = await tryAddDecoratedClassMethod({
    projectRoot,
    file: plan.controllerFile,
    className: plan.controllerClass,
    methodName: plan.controllerMethod,
    parameters,
    returnType: "",
    isAsync: true,
    body,
    decorator: {
      name: HTTP_TO_DECORATOR[plan.httpMethod],
      argument: JSON.stringify(plan.routePath),
      importFrom: "@nestjs/common",
    },
  });
  if (r.kind === "skipped") return r;
  let next: TransformResult = r;
  if (needsBody) {
    next = addImportToApplied(projectRoot, next, "Body", "@nestjs/common");
    if (next.kind === "skipped") return next;
  }
  if (plan.dtoName && plan.dtoFile) {
    next = addImportToApplied(projectRoot, next as AppliedTransform, plan.dtoName, importSpecifier(plan.controllerFile, plan.dtoFile));
  }
  return next;
}

async function addServiceMethod(projectRoot: string, plan: BackendScaffoldPlan): Promise<TransformResult> {
  const parameters = plan.dtoName ? `dto: ${plan.dtoName}` : "";
  const body = `// TODO: implement ${plan.serviceMethod}`;
  const r = await tryAddClassMethod({
    projectRoot,
    file: plan.serviceFile,
    className: plan.serviceClass,
    methodName: plan.serviceMethod,
    parameters,
    returnType: "Promise<unknown>",
    isAsync: true,
    body,
  });
  if (r.kind === "skipped") return r;
  if (plan.dtoName && plan.dtoFile) {
    return addImportToApplied(projectRoot, r, plan.dtoName, importSpecifier(plan.serviceFile, plan.dtoFile));
  }
  return r;
}

function addImportToApplied(
  projectRoot: string,
  transform: AppliedTransform,
  name: string,
  specifier: string,
): TransformResult {
  if (!specifier) return transform;
  const result = addNamedImportToContent(transform.updatedContent, {
    file: transform.file,
    specifier,
    names: [name],
  });
  if (!result.ok) {
    return makeSkip(transform.transformType, transform.file, result.code, result.reason);
  }
  if (result.updated === transform.updatedContent) return transform;
  const validation = validatePostEdit(transform.originalContent, result.updated);
  if (!validation.ok) return makeSkip(transform.transformType, transform.file, "validation-failed", validation.reason);
  const exportDiff = computeExportDelta(transform.originalContent, result.updated);
  if (exportDiff.missing.length > 0) {
    return makeSkip(transform.transformType, transform.file, "validation-failed", `Edit dropped exports: ${exportDiff.missing.join(", ")}.`);
  }
  return {
    ...transform,
    updatedContent: result.updated,
    diff: buildUnifiedDiff(transform.file, transform.originalContent, result.updated),
    exportDiff,
    insertedSnippetSummary: `${transform.insertedSnippetSummary}; ${result.summary}`,
    notes: `${transform.notes}; ${result.notes}`,
  };
}

async function createDtoInterface(projectRoot: string, file: string, dtoName: string): Promise<TransformResult> {
  const abs = resolve(projectRoot, file);
  if (existsSync(abs)) {
    return makeSkip("dto-file-create", file, "duplicate", `DTO file already exists at ${file}.`);
  }
  const updated = `export interface ${dtoName} {\n  // TODO: define ${dtoName} fields\n}\n`;
  return {
    kind: "applied",
    transformType: "dto-file-create",
    file,
    originalContent: "",
    updatedContent: updated,
    diff: buildUnifiedDiff(file, "", updated),
    matchedPattern: `create ${dtoName}`,
    insertedSnippetSummary: `export interface ${dtoName}`,
    exportDiff: computeExportDelta("", updated),
    notes: `Created scaffold DTO interface ${dtoName}.`,
  };
}

function fail(skipped: readonly SkippedTransform[]): ScaffoldResult {
  return {
    kind: "skipped",
    skipped,
    reason: skipped.length > 0
      ? `Scaffold refused: ${skipped.map((s) => `${s.file} (${s.reasonCode})`).join("; ")}`
      : "Scaffold refused.",
  };
}

function push(applied: AppliedTransform[], skipped: SkippedTransform[], r: TransformResult): void {
  if (r.kind === "applied") applied.push(r);
  else skipped.push(r);
}

function skip(
  transformType: SkippedTransform["transformType"] | "multi-file-scaffold",
  file: string,
  code: SkippedTransform["reasonCode"],
  reason: string,
): ScaffoldPlanResult {
  return { ok: false, skipped: makeSkip(transformType === "multi-file-scaffold" ? "decorated-class-method-add" : transformType, file, code, reason) };
}

function makeSkip(
  transformType: SkippedTransform["transformType"],
  file: string,
  reasonCode: SkippedTransform["reasonCode"],
  reason: string,
): SkippedTransform {
  return { kind: "skipped", transformType, file, reasonCode, reason };
}

async function collectCandidateFiles(projectRoot: string, targetFiles: readonly string[]): Promise<Array<{ path: string; content: string }>> {
  const candidates = new Set<string>();
  for (const target of targetFiles) {
    const abs = resolve(projectRoot, target);
    if (existsSync(abs)) candidates.add(normalizeRel(projectRoot, abs));
    else candidates.add(target);
  }
  for (const file of walkTsFiles(projectRoot)) candidates.add(file);
  const out: Array<{ path: string; content: string }> = [];
  for (const path of candidates) {
    const abs = resolve(projectRoot, path);
    if (!existsSync(abs)) continue;
    out.push({ path, content: await readFile(abs, "utf-8") });
  }
  return out;
}

function walkTsFiles(projectRoot: string): string[] {
  const out: string[] = [];
  const ignore = new Set([".git", "node_modules", "dist", "build", "coverage", ".aedis"]);
  const visit = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      if (ignore.has(entry)) continue;
      const abs = resolve(dir, entry);
      const st = statSync(abs);
      if (st.isDirectory()) visit(abs);
      else if (/\.tsx?$/.test(entry) && !/\.(test|spec)\.tsx?$/.test(entry)) out.push(normalizeRel(projectRoot, abs));
    }
  };
  visit(projectRoot);
  return out;
}

function hasClass(content: string, className: string): boolean {
  return new RegExp(`(^|\\n)\\s*(?:export\\s+)?(?:abstract\\s+)?class\\s+${escapeRe(className)}\\b`).test(content);
}

function findFirstClass(content: string, suffix: RegExp): string | null {
  const re = /(?:^|\n)\s*(?:export\s+)?(?:abstract\s+)?class\s+([A-Z][\w$]*)\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    if (suffix.test(m[1])) return m[1];
  }
  return null;
}

function findServiceProperty(content: string, controllerClass: string, serviceClass: string): string | null {
  const loc = locateClassBody(content, controllerClass);
  if (!loc) return null;
  const body = content.slice(loc.open + 1, loc.close);
  const paramProp = new RegExp(`\\b(?:public|private|protected)\\s+(?:readonly\\s+)?([A-Za-z_$][\\w$]*)\\s*:\\s*${escapeRe(serviceClass)}\\b`).exec(body);
  if (paramProp) return paramProp[1];
  const field = new RegExp(`\\b([A-Za-z_$][\\w$]*)\\s*:\\s*${escapeRe(serviceClass)}\\b`).exec(body);
  return field?.[1] ?? null;
}

function locateClassBody(content: string, className: string): { open: number; close: number } | null {
  const m = new RegExp(`\\bclass\\s+${escapeRe(className)}\\b`).exec(content);
  if (!m) return null;
  const open = content.indexOf("{", m.index);
  if (open < 0) return null;
  const close = findMatchingDelimiter(content, open, "{");
  return close < 0 ? null : { open, close };
}

function findDtoFile(files: readonly { path: string; content: string }[], dtoName: string): string | null {
  const matches = files.filter((f) =>
    new RegExp(`\\b(?:interface|class|type)\\s+${escapeRe(dtoName)}\\b`).test(f.content),
  );
  return matches.length === 1 ? matches[0].path : null;
}

function importSpecifier(fromFile: string, toFile: string): string {
  if (fromFile === toFile) return "";
  const fromDir = dirname(fromFile);
  const withoutExt = toFile.replace(/\.[cm]?[tj]sx?$/, "");
  let rel = posix.normalize(relative(fromDir, withoutExt).split(sep).join(posix.sep));
  if (!rel.startsWith(".")) rel = `./${rel}`;
  return rel;
}

function normalizeRel(root: string, abs: string): string {
  return relative(root, abs).split(sep).join(posix.sep);
}

function lowerFirst(s: string): string {
  return s.charAt(0).toLowerCase() + s.slice(1);
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
