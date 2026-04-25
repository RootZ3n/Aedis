/**
 * Task-shape detector — turns the user's natural-language request into
 * a structural label so the Builder can pick a localized edit strategy
 * instead of treating every prompt the same way.
 *
 * Lives in core/ (not workers/) because both the Builder prompt and the
 * brief generator need to consult it.
 *
 * Pure functions, no I/O.
 */

export type TaskShape =
  | "route-add"            // "add GET /health endpoint", "add POST /chat", "expose a /models route"
  | "config-update"        // "update timeout config", "add env var"
  | "type-sharing"         // "extract X into a shared type"
  | "type-extend"          // "add email:string to User interface", "add field X to UserSchema"
  | "class-extend"         // "add private logger:Logger to UserService", "add async createUser(user:User):Promise<void> to UserService"
  | "general";

export interface ClassExtendDetails {
  /** Class symbol name. */
  readonly className: string;
  readonly memberKind: "field" | "method" | "constructor-param";
  readonly memberName: string;
  /** For fields: the TS type (e.g. "Logger", "string"). For methods: the return type. */
  readonly memberType: string;
  /** For methods: the parameter list contents (without parens). Empty for fields. */
  readonly parameters: string;
  /** For methods: the body text (without braces). Empty by default. */
  readonly body: string;
  readonly visibility?: "public" | "private" | "protected";
  readonly isStatic: boolean;
  readonly isReadonly: boolean;
  readonly isAsync: boolean;
  readonly optional: boolean;
  readonly decorator?: {
    readonly name: string;
    readonly argument?: string;
    readonly importFrom?: string;
    readonly routeMethod?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
    readonly routePath?: string;
  };
}

export interface TypeExtendDetails {
  /** Symbol the user named — "User", "UserSchema", "ApiResponse". */
  readonly symbol: string;
  /** Property/field name. */
  readonly property: string;
  /** TypeScript type expression — "string", "Record<string,string>". */
  readonly propertyType: string;
  /** Optional flag (`?:`). */
  readonly optional: boolean;
  /** Readonly flag. */
  readonly readonly: boolean;
  /**
   * Hint about what kind of construct the user thinks they're editing.
   * The transform layer still inspects the file to make the final
   * choice — this is just the parser's best guess from the prompt.
   */
  readonly kindHint: "interface" | "type" | "schema" | "unknown";
}

export interface TaskShapeFinding {
  readonly shape: TaskShape;
  readonly evidence: readonly string[];
  /** When shape=="route-add", which HTTP verbs were named (uppercased). */
  readonly httpVerbs: readonly string[];
  /** When shape=="route-add", which paths were named. */
  readonly httpPaths: readonly string[];
  /** When shape=="type-extend", parsed details. */
  readonly typeExtend?: TypeExtendDetails;
  /** When shape=="class-extend", parsed details. */
  readonly classExtend?: ClassExtendDetails;
}

const HTTP_VERB_TOKENS = new Set([
  "GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD",
]);

const ROUTE_VERBS = ["add", "create", "implement", "expose", "register", "wire", "introduce"];
const NEST_HTTP_DECORATORS: Record<string, "Get" | "Post" | "Put" | "Patch" | "Delete"> = {
  GET: "Get",
  POST: "Post",
  PUT: "Put",
  PATCH: "Patch",
  DELETE: "Delete",
};

/**
 * Detect whether the user is asking to add an HTTP endpoint.
 *
 * Triggers on EITHER:
 *   - explicit verb + HTTP method: "add GET /health"
 *   - "add ... endpoint" or "add ... route" with optional path: "add a /models endpoint"
 *
 * Returns "general" when nothing matches — caller falls back to the
 * usual full-file builder strategy.
 */
export function classifyTaskShape(userRequest: string | null | undefined): TaskShapeFinding {
  if (!userRequest || typeof userRequest !== "string") {
    return { shape: "general", evidence: [], httpVerbs: [], httpPaths: [] };
  }
  const text = userRequest.trim();
  const lower = text.toLowerCase();
  const evidence: string[] = [];
  const httpVerbs = new Set<string>();
  const httpPaths = new Set<string>();

  // Direct HTTP verb mentions
  const verbRegex = /\b(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)\b\s+(\/[\w\-\/:.]*)?/gi;
  let match: RegExpExecArray | null;
  while ((match = verbRegex.exec(text)) !== null) {
    const verb = match[1].toUpperCase();
    if (HTTP_VERB_TOKENS.has(verb)) {
      httpVerbs.add(verb);
      if (match[2]) httpPaths.add(match[2]);
      evidence.push(`http-verb:${verb}${match[2] ? ` ${match[2]}` : ""}`);
    }
  }

  // Endpoint / route nouns near a "add/create" verb
  const verbAlternation = ROUTE_VERBS.join("|");
  const endpointRegex = new RegExp(
    `\\b(?:${verbAlternation})\\b[\\s\\S]{0,40}\\b(endpoint|route|handler)\\b`,
    "i",
  );
  if (endpointRegex.test(lower)) {
    evidence.push("endpoint-noun");
  }

  // Bare paths like "/health", "/v1/chat", "/models"
  const pathRegex = /(?<!\w)\/[a-z][\w\-\/:.]*/gi;
  while ((match = pathRegex.exec(text)) !== null) {
    const candidate = match[0];
    // Exclude file-extension lookalikes (e.g. "/foo/bar.ts").
    if (/\.[a-z]+$/i.test(candidate)) continue;
    httpPaths.add(candidate);
    evidence.push(`path:${candidate}`);
  }

  const decoratedControllerMethod = parseDecoratedControllerMethodPrompt(text, [...httpVerbs], [...httpPaths]);
  if (decoratedControllerMethod) {
    return {
      shape: "class-extend",
      evidence: [
        "decorated-controller-method",
        `class:${decoratedControllerMethod.className}`,
        `member:${decoratedControllerMethod.memberKind}`,
        `name:${decoratedControllerMethod.memberName}`,
        `decorator:${decoratedControllerMethod.decorator?.name ?? ""}`,
      ],
      httpVerbs: [...httpVerbs].sort(),
      httpPaths: [...httpPaths].sort(),
      classExtend: decoratedControllerMethod,
    };
  }

  if (httpVerbs.size > 0 || (evidence.includes("endpoint-noun") && httpPaths.size > 0)) {
    return {
      shape: "route-add",
      evidence,
      httpVerbs: [...httpVerbs].sort(),
      httpPaths: [...httpPaths].sort(),
    };
  }

  // Config-update detector
  if (/\b(env|environment|config|configuration|setting|option)\b/i.test(lower) &&
      /\b(add|update|change|set|toggle)\b/i.test(lower)) {
    return { shape: "config-update", evidence: ["config-keywords"], httpVerbs: [], httpPaths: [] };
  }

  // Type-sharing detector
  if (/\b(extract|share|hoist|consolidate)\b/i.test(lower) &&
      /\b(type|interface|enum|schema)\b/i.test(lower)) {
    return { shape: "type-sharing", evidence: ["type-keywords"], httpVerbs: [], httpPaths: [] };
  }

  // Class-extend detector — "add [modifier]* method X(...) to ClassY",
  // "add private field X:T to ClassY", "extend ClassY with method X".
  // Run BEFORE type-extend so prompts that include `(` or class-shaped
  // member words don't get parsed as type-aliases by mistake.
  const classExtend = parseClassExtendPrompt(text);
  if (classExtend) {
    return {
      shape: "class-extend",
      evidence: [
        "class-extend-keywords",
        `class:${classExtend.className}`,
        `member:${classExtend.memberKind}`,
        `name:${classExtend.memberName}`,
      ],
      httpVerbs: [],
      httpPaths: [],
      classExtend,
    };
  }

  // Type-extend detector — "add X to <Symbol>", "add field X to schema Y"
  const typeExtend = parseTypeExtendPrompt(text);
  if (typeExtend) {
    return {
      shape: "type-extend",
      evidence: ["type-extend-keywords", `symbol:${typeExtend.symbol}`, `prop:${typeExtend.property}`],
      httpVerbs: [],
      httpPaths: [],
      typeExtend,
    };
  }

  return { shape: "general", evidence, httpVerbs: [], httpPaths: [] };
}

function parseDecoratedControllerMethodPrompt(
  text: string,
  verbs: readonly string[],
  paths: readonly string[],
): ClassExtendDetails | null {
  const explicitDecorator = /@(?:Get|Post|Put|Patch|Delete)\s*\(\s*(["'][^"']*["'])?\s*\)/i.exec(text);
  const explicitDecoratorName = explicitDecorator ? /@(Get|Post|Put|Patch|Delete)/i.exec(explicitDecorator[0])?.[1] : null;
  const verb = explicitDecoratorName
    ? explicitDecoratorName.toUpperCase()
    : verbs.find((v) => NEST_HTTP_DECORATORS[v]);
  if (!verb || !NEST_HTTP_DECORATORS[verb]) return null;
  if (!/\b[A-Z][\w$]*Controller\b/.test(text) && !/\bnestjs\b/i.test(text) && !explicitDecoratorName) return null;

  const classMatch = /\b(?:to|in|into|on)\s+([A-Z][\w$]*Controller)\b/.exec(text) ??
    /\b([A-Z][\w$]*Controller)\b/.exec(text);
  if (!classMatch) return null;
  const className = classMatch[1];
  const methodMatch = /\bmethod\s+([A-Za-z_$][\w$]*)\b/i.exec(text);
  const routePath = normalizePromptPath(
    explicitDecorator?.[1] ?? paths[0] ?? "",
  );
  const memberName = methodMatch?.[1] ?? inferRouteMethodName(verb, routePath);
  if (!memberName) return null;
  const decorator = NEST_HTTP_DECORATORS[verb];
  return {
    className,
    memberKind: "method",
    memberName,
    memberType: "",
    parameters: "",
    body: "",
    visibility: undefined,
    isStatic: false,
    isReadonly: false,
    isAsync: true,
    optional: false,
    decorator: {
      name: decorator,
      argument: routePath ? JSON.stringify(routePath) : "",
      importFrom: "@nestjs/common",
      routeMethod: verb as "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
      routePath,
    },
  };
}

function normalizePromptPath(path: string): string {
  const trimmed = path.trim();
  if (!trimmed) return "";
  const quoted = /^["']([^"']*)["']$/.exec(trimmed);
  return quoted ? quoted[1] : trimmed;
}

function inferRouteMethodName(verb: string, routePath: string): string {
  const base = routePath.split("/").filter(Boolean).pop() ?? "route";
  const pascal = base
    .split(/[-_:]/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
  const prefix = verb === "POST" ? "create" : verb === "PUT" ? "update" : verb === "PATCH" ? "patch" : verb === "DELETE" ? "delete" : "get";
  return `${prefix}${pascal || "Route"}`;
}

/**
 * Parse a natural-language prompt into structured class-extend details.
 * Returns null when the prompt doesn't look like one.
 *
 * Recognized shapes:
 *
 *   add [private|public|protected] [readonly|static] <name>:<type> to <ClassName>
 *   add [modifier]* field <name>:<type> to <ClassName>
 *   add [modifier]* property <name>:<type> to <ClassName>
 *   add [modifier]* [async|static] method <name>(<params>):<retType> to <ClassName>
 *   add [modifier]* [async|static] <name>(<params>) to <ClassName>
 *   add [modifier]* [async] method <name> to <ClassName>
 *   extend <ClassName> with method <name>(<params>):<retType>
 *   extend <ClassName> with field <name>:<type>
 *
 * Heuristics for kind:
 *   - if a `(...)` is present after the candidate member name AND
 *     before the "to <ClassName>" anchor -> method
 *   - else if the word "method" / "function" appears -> method
 *   - else if `name:type` is present -> field
 *   - else if "field" / "property" word -> field
 */
export function parseClassExtendPrompt(text: string): ClassExtendDetails | null {
  if (!/\b(add|extend|append|attach)\b/i.test(text)) return null;

  // Class-extend requires AT LEAST ONE strong signal that the user
  // is talking about a class — not an interface / type alias / Zod
  // schema / config object. Without one of these signals the prompt
  // routes to type-extend instead.
  const hasClassWord = /\bclass\b/i.test(text);
  const hasMethodToken = /\bmethod\b|\bfunction\b/i.test(text);
  const hasConstructorWord = /\bconstructor\b/i.test(text);
  const hasParenSig = /\b[A-Za-z_$][\w$]*\s*\(/.test(text);
  const hasClassOnlyModifier = /\b(?:private|public|protected|static|async)\b/i.test(text);
  // `readonly` is shared between class fields and interface/type
  // properties, so it's a weak signal — counts only when nothing
  // else in the prompt looks interface/type/schema-shaped.
  const hasReadonlyModifier = /\breadonly\b/i.test(text);
  const hasInterfaceTypeSchemaWord = /\b(interface|type alias|schema|config)\b/i.test(text);
  // Class-suffixed names — Service / Controller / Repository / etc.
  // are classic OOP class conventions.
  const hasClassSuffixedName = /\b[A-Z][\w]*(?:Service|Controller|Repository|Manager|Provider|Client|Adapter|Handler|Worker|Executor|Engine|Builder|Factory)\b/.test(text);

  const strongSignal = hasClassWord || hasMethodToken || hasConstructorWord || hasParenSig || hasClassOnlyModifier;
  const mediumSignal = hasReadonlyModifier && (hasClassSuffixedName || !hasInterfaceTypeSchemaWord);
  if (!strongSignal && !mediumSignal) return null;

  // Negative gating — if the prompt explicitly mentions interface or
  // type alias or schema (and there's NO strong class-only signal),
  // let the type-extend detector handle it.
  if (hasInterfaceTypeSchemaWord && !hasClassWord && !hasMethodToken && !hasParenSig && !hasClassOnlyModifier) {
    return null;
  }

  // Three prompt orders to handle:
  //   (1) "add … to <ClassName>"                  — class at the END
  //   (2) "extend <ClassName> with …"              — class at the START
  //   (3) "add … to constructor of <ClassName>"   — constructor DI param
  const ctorAnchorRe = /\bto\s+constructor\s+of\s+([A-Z][\w$]*)\b/i;
  const ctorOfMatch = ctorAnchorRe.exec(text);
  const ctorInClassRe = /\bin\s+([A-Z][\w$]*)\s+constructor\b/i;
  const ctorInMatch = !ctorOfMatch ? ctorInClassRe.exec(text) : null;
  const isConstructorParam = !!ctorOfMatch || !!ctorInMatch;

  const extendWithRe = /\bextend(?:ing)?\s+([A-Z][\w$]*)\s+with\b/i;
  const extendWithMatch = !isConstructorParam ? extendWithRe.exec(text) : null;

  let className: string;
  let beforeAnchor: string;
  if (ctorOfMatch) {
    className = ctorOfMatch[1];
    beforeAnchor = text.slice(0, ctorOfMatch.index);
  } else if (ctorInMatch) {
    className = ctorInMatch[1];
    // For "in <Class> constructor" the member info is wherever "add"
    // starts in the prompt; pass the whole text minus the anchor.
    beforeAnchor = text.slice(0, ctorInMatch.index);
  } else if (extendWithMatch) {
    className = extendWithMatch[1];
    beforeAnchor = text.slice(extendWithMatch.index + extendWithMatch[0].length);
  } else {
    const classRe = /(?:\bto\b|\bonto\b|\binto\b|\bwith\b)\s+([A-Z][\w$]*)\b/;
    const classMatch = classRe.exec(text);
    if (!classMatch) return null;
    className = classMatch[1];
    beforeAnchor = text.slice(0, classMatch.index);
  }

  const visMatch = /\b(public|private|protected)\b/i.exec(text);
  const visibility = visMatch ? (visMatch[1].toLowerCase() as "public" | "private" | "protected") : undefined;
  const isStatic = /\bstatic\b/i.test(text);
  const isReadonly = /\breadonly\b/i.test(text);
  const isAsync = /\basync\b/i.test(text);
  const optional = /\?:/.test(text) || /\b(optional|nullable)\b/i.test(text);
  const decorator = parseSimpleDecorator(text);

  const hasMethodWord = /\bmethod\b|\bfunction\b/i.test(beforeAnchor);

  // Try method shape first: a `(...)` appearing in beforeAnchor.
  const methodSig =
    /\b([A-Za-z_$][\w$]*)\s*\(([^)]*)\)\s*(?::\s*([^.\n]+?))?\s*(?:method\s*)?$/i.exec(beforeAnchor.trim());
  if (methodSig) {
    const memberName = methodSig[1];
    const parameters = (methodSig[2] ?? "").trim();
    const returnType = stripTrailingNoise(methodSig[3] ?? "");
    return {
      className,
      memberKind: "method",
      memberName,
      memberType: returnType,
      parameters,
      body: "",
      visibility,
      isStatic,
      isReadonly: false,
      isAsync,
      optional: false,
      decorator,
    };
  }
  if (hasMethodWord) {
    // "add method <name>" or "<name> method" without a signature.
    const named =
      /\b(?:method|function)\s+([A-Za-z_$][\w$]*)\b/i.exec(beforeAnchor) ??
      /\b([A-Za-z_$][\w$]*)\s+(?:method|function)\b/i.exec(beforeAnchor);
    if (named) {
      return {
        className,
        memberKind: "method",
        memberName: named[1],
        memberType: "",
        parameters: "",
        body: "",
        visibility,
        isStatic,
        isReadonly: false,
        isAsync,
        optional: false,
        decorator,
      };
    }
  }

  // Field shape: `<name>: <type>` (no parens before the anchor).
  // Skip identifiers that ARE keywords we already consumed (modifiers).
  const fieldSig =
    /\b([A-Za-z_$][\w$]*)\s*\??\s*:\s*([\w$<>\[\]{},\s|&]+?)\s*(?:field|property)?\s*$/i.exec(
      beforeAnchor.trim().replace(/^(?:add|extend|append|attach)\s+/i, ""),
    );
  if (fieldSig) {
    const candidateName = fieldSig[1];
    // Reject if the captured "name" is actually a modifier word.
    if (!/^(?:public|private|protected|static|readonly|async|abstract|override|optional|nullable)$/i.test(candidateName)) {
      return {
        className,
        memberKind: isConstructorParam ? "constructor-param" : "field",
        memberName: candidateName,
        memberType: stripTrailingNoise(fieldSig[2]),
        parameters: "",
        body: "",
        visibility,
        isStatic,
        isReadonly,
        isAsync: false,
        optional,
        decorator,
      };
    }
  }

  // Bare field: "add field X to ClassY" / "add X field to ClassY"
  const bareFieldFirst =
    /\b(?:add|extend|append|attach)\b[\s\S]*?\b(?:field|property)\s+([A-Za-z_$][\w$]*)\b/i.exec(beforeAnchor);
  const bareFieldLast =
    /\b(?:add|extend|append|attach)\b[\s\S]*?\b([A-Za-z_$][\w$]*)\s+(?:field|property)\b/i.exec(beforeAnchor);
  const bareField = bareFieldFirst ?? bareFieldLast;
  if (bareField) {
    const ofTypeMatch = /\bof\s+type\s+([A-Za-z_$][\w$]*(?:\[\])?(?:<[^>]+>)?)/i.exec(beforeAnchor);
    return {
      className,
      memberKind: isConstructorParam ? "constructor-param" : "field",
      memberName: bareField[1],
      memberType: ofTypeMatch?.[1] ?? "string",
      parameters: "",
      body: "",
      visibility,
      isStatic,
      isReadonly,
      isAsync: false,
      optional,
      decorator,
    };
  }

  return null;
}

function parseSimpleDecorator(text: string): ClassExtendDetails["decorator"] | undefined {
  const m = /@([A-Z][A-Za-z0-9_$]*)\s*\(([^)]*)\)/.exec(text);
  if (!m) return undefined;
  const name = m[1];
  const rawArg = m[2].trim();
  const routeVerb = Object.entries(NEST_HTTP_DECORATORS).find(([, dec]) => dec === name)?.[0] as
    | "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | undefined;
  const routePath = routeVerb ? normalizePromptPath(rawArg) : undefined;
  const importFrom = routeVerb || name === "Inject" ? "@nestjs/common" : undefined;
  return {
    name,
    argument: routeVerb && routePath ? JSON.stringify(routePath) : rawArg,
    importFrom,
    routeMethod: routeVerb,
    routePath,
  };
}

/**
 * Parse a natural-language prompt into structured type-extend details.
 * Returns null when the prompt doesn't look like a type-extend ask.
 *
 * Recognized patterns:
 *   "add <prop>:<type> to <symbol> interface"
 *   "add <prop>:<type> to <symbol>"
 *   "add an? optional? <prop>:<type> to <symbol>"
 *   "add field <prop> of type <type> to <symbol>"
 *   "add <prop> field to <symbol>"           (defaults type to "string")
 *   "extend <symbol> with <prop>:<type>"
 *
 * The parser is conservative: when the type is missing or the
 * construct word is unclear, it still returns a finding — the
 * transform layer's pre-validation will tell the truth.
 */
export function parseTypeExtendPrompt(text: string): TypeExtendDetails | null {
  const lower = text.toLowerCase();
  if (!/\b(add|extend|append|attach)\b/.test(lower)) return null;

  // Construct hint: "interface", "type", "schema". Default to unknown.
  // Symbol names are inspected too — "FeatureFlagSchema" / "UserModel"
  // strongly suggests the relevant construct kind.
  let kindHint: TypeExtendDetails["kindHint"] = "unknown";
  if (/\binterface\b/i.test(text)) kindHint = "interface";
  else if (/\btype\b/i.test(text) && !/\btype\s+of\b/i.test(text)) kindHint = "type";
  else if (/\bschema\b/i.test(text) || /\b[A-Z][\w]*Schema\b/.test(text)) kindHint = "schema";

  const optional = /\b(optional|nullable|maybe)\b/i.test(text) || /\?:/.test(text);
  const readonlyFlag = /\breadonly\b/i.test(text);

  // Strategy A: <prop>:<type> ... to <symbol>
  // The type can include angle brackets, commas, generics. Stop at
  // " to " or " on " or end of string.
  const colonMatch =
    /\b(?:add|extend|append|attach)\b[\s\S]*?\b([A-Za-z_$][\w$]*)\s*\??\s*:\s*([^\n]+?)\s+(?:to|on|in|onto|into)\s+([A-Za-z_$][\w$]*)/i.exec(text);
  if (colonMatch) {
    const [, prop, rawType, symbol] = colonMatch;
    return {
      symbol,
      property: prop,
      propertyType: stripTrailingNoise(rawType),
      optional,
      readonly: readonlyFlag,
      kindHint,
    };
  }

  // Strategy B: bare "add <prop> field to <symbol>" or "add <prop> to <symbol>"
  // (no explicit type; default "string"). Accepts both word orders:
  //   "add field <prop>"     and   "add <prop> field"
  const bareFieldFirst =
    /\b(?:add|extend|append|attach)\b[\s\S]*?\b(?:field|property|key|prop)\s+([A-Za-z_$][\w$]*)[\s\S]*?\b(?:to|on)\b\s+([A-Za-z_$][\w$]*)/i.exec(text);
  const bareFieldLast =
    /\b(?:add|extend|append|attach)\b[\s\S]*?\b([A-Za-z_$][\w$]*)\s+(?:field|property|key|prop)\b[\s\S]*?\b(?:to|on)\b\s+([A-Za-z_$][\w$]*)/i.exec(text);
  const bareMatch = bareFieldFirst ?? bareFieldLast;
  if (bareMatch) {
    const [, prop, symbol] = bareMatch;
    const ofTypeMatch = /\bof\s+type\s+([A-Za-z_$][\w$]*(?:\[\])?(?:<[^>]+>)?)/i.exec(text);
    const inferredType = ofTypeMatch?.[1] ?? "string";
    return {
      symbol,
      property: prop,
      propertyType: inferredType,
      optional,
      readonly: readonlyFlag,
      kindHint,
    };
  }

  // Strategy C: "extend <Symbol> with <prop>:<type>"
  const extendMatch =
    /\bextend(?:ing)?\s+([A-Za-z_$][\w$]*)\s+with\s+([A-Za-z_$][\w$]*)\s*\??\s*:\s*([^\n.]+)/i.exec(text);
  if (extendMatch) {
    const [, symbol, prop, rawType] = extendMatch;
    return {
      symbol,
      property: prop,
      propertyType: stripTrailingNoise(rawType),
      optional,
      readonly: readonlyFlag,
      kindHint,
    };
  }

  return null;
}

function stripTrailingNoise(raw: string): string {
  // Trim trailing punctuation/noise. Keep angle brackets and commas
  // inside <…> intact.
  let t = raw.trim();
  t = t.replace(/[.;]+$/, "");
  // Trim trailing words like "please", "if possible".
  t = t.replace(/\s+(please|if\s+possible|thanks?)$/i, "");
  return t.trim();
}

/**
 * Build a builder-prompt fragment describing the route-insertion
 * strategy. Empty string for non-route tasks.
 */
export function routeStrategyDirective(finding: TaskShapeFinding): string {
  if (finding.shape !== "route-add") return "";
  const verbs = finding.httpVerbs.length > 0 ? finding.httpVerbs.join("/") : "an HTTP";
  const paths = finding.httpPaths.length > 0 ? finding.httpPaths.join(", ") : "the requested";
  return [
    `ROUTE-ADD STRATEGY (this prompt is asking you to add ${verbs} ${paths} endpoint(s)):`,
    "  • Find existing route registrations in the file (e.g. app.get / fastify.get / router.get / app.post).",
    "  • INSERT the new handler BESIDE the existing ones — same style, same indentation, same registration pattern.",
    "  • Do NOT rewrite the file end-to-end. Most lines must remain byte-identical.",
    "  • Do NOT remove, rename, or reshuffle any existing handler — additions only.",
    "  • If the new route reuses helpers (response shape, auth, logging), import or call the existing ones rather than re-implementing.",
    "  • Preserve every existing top-level export. The route-add must NOT change the file's export surface unless the task explicitly says so.",
  ].join("\n");
}
