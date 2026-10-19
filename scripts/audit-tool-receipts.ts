/**
 * Phase 4 coverage script: audits writeMutationReceipt coverage across the 3 tool-source files.
 *
 * Uses TypeScript AST parsing (NOT regex) to correctly handle tools whose Zod schemas
 * contain `{` `}` literals that would break naive brace-counting.
 *
 * Classification rules (ordered — first match wins):
 *   1. Excluded: tool name in audit/tool-receipt-exclusions.json → OK
 *   2. OutboundGateway-centralized: send_to_channel | dispatch_outbound_batch → OK
 *   3. Task-dispatch-centralized: dispatch_task | dispatch_to_role | dispatch_by_requirements | decompose_goal → OK
 *      (schedule_task is NOT in this list — it calls createTaskTemplate directly and gets
 *       a local writeMutationReceipt call per Task 3)
 *   4. Tool-local: handler body AST (or the called handler's body) contains
 *      writeMutationReceipt or writeEffectReceipt → OK
 *      Handles the shared-tools.ts pattern: tool(..., async (args) => handleSave(scopedRoleId, args))
 *      where writeMutationReceipt lives inside handleSave/handleDelete, not the arrow wrapper.
 *   5. Otherwise: MISSING
 *
 * Also asserts every exclusion name corresponds to at least one actually-discovered tool
 * (catches stale exclusions when a tool gets renamed/removed).
 *
 * Exit code 0 = all covered. Exit code 1 = any MISSING instance OR stale exclusion.
 */
import ts from "typescript";
import { readFileSync } from "node:fs";
import { resolve, join } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname, "..");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseAst(filePath: string): ts.SourceFile {
  const source = readFileSync(filePath, "utf8");
  return ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

function findCallExpressions(node: ts.Node, pred: (n: ts.CallExpression) => boolean): ts.CallExpression[] {
  const results: ts.CallExpression[] = [];
  function walk(n: ts.Node) {
    if (ts.isCallExpression(n) && pred(n)) results.push(n);
    ts.forEachChild(n, walk);
  }
  walk(node);
  return results;
}

function getToolName(call: ts.CallExpression): string | null {
  const args = call.arguments;
  if (args.length === 0) return null;
  const first = args[0];
  if (ts.isStringLiteral(first)) return first.text;
  return null;
}

/**
 * Get the handler body from a tool() call.
 *
 * Standard pattern (most tools):
 *   tool("name", "desc", schema, async (args) => { ... body ... })
 *   tool("name", "desc", schema, (args) => { ... body ... })
 *
 * Wrapper pattern (shared-tools.ts):
 *   tool("name", "desc", schema, async (args) => handleSave(scopedRoleId, args))
 *   tool("name", "desc", schema, (args) => handleDelete(scopedRoleId, args))
 *   The writeMutationReceipt call lives INSIDE handleSave/handleDelete, not in the arrow wrapper.
 *
 * This function returns the body's Node. For the wrapper pattern it returns the handler
 * function's body directly (to allow the caller to look inside). For the standard pattern it
 * returns the block body.
 */
function getHandlerBody(call: ts.CallExpression): ts.Node | null {
  const args = call.arguments;
  for (let i = 2; i < args.length; i++) {
    const arg = args[i];
    if (ts.isArrowFunction(arg) || ts.isFunctionExpression(arg)) {
      if (ts.isBlock(arg.body)) return arg.body;
      // expression body: async (args) => handleSave(scopedRoleId, args) or similar
      return arg.body;
    }
  }
  return null;
}

/**
 * Find named top-level function declarations in a SourceFile.
 * Used to look through handler wrappers that delegate to module-level functions.
 */
function findNamedFunction(sourceFile: ts.SourceFile, name: string): ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression | null {
  const results: Array<ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression> = [];
  function walk(n: ts.Node) {
    if (
      (ts.isFunctionDeclaration(n) && n.name?.text === name) ||
      (ts.isArrowFunction(n) && (n.parent && ts.isVariableDeclaration(n.parent) ? (n.parent as ts.VariableDeclaration).name?.getText() === name : false)) ||
      (ts.isFunctionExpression(n) && (n.parent && ts.isVariableDeclaration(n.parent) ? (n.parent as ts.VariableDeclaration).name?.getText() === name : false))
    ) {
      results.push(n);
    }
    ts.forEachChild(n, walk);
  }
  walk(sourceFile);
  return results[0] ?? null;
}

/**
 * For a given handler body (arrow fn / function expr block), determine if it directly or
 * transitively calls writeMutationReceipt / writeEffectReceipt.
 *
 * Handles the shared-tools.ts pattern where tool() arrow wrappers delegate to module-level
 * functions (handleSave, handleDelete) that contain the writeMutationReceipt call.
 */
function bodyContainsReceiptWrite(body: ts.Node | null, sourceFile: ts.SourceFile): boolean {
  if (!body) return false;

  // Direct call in body
  const directCalls = findCallExpressions(body, (c) => {
    const fn = c.expression;
    if (ts.isIdentifier(fn)) return fn.text === "writeMutationReceipt" || fn.text === "writeEffectReceipt";
    return false;
  });
  if (directCalls.length > 0) return true;

  // Follow delegation calls (shared-tools.ts pattern)
  // e.g. handleSave(scopedRoleId, args) or handleDelete(scopedRoleId, args)
  const delegationCalls = findCallExpressions(body, (c) => {
    const fn = c.expression;
    if (!ts.isIdentifier(fn)) return false;
    const name = fn.text;
    // These are the handler wrapper function names used in shared-tools.ts
    if (name === "handleSearch" || name === "handleSave" || name === "handleDelete") {
      return true;
    }
    return false;
  });

  for (const del of delegationCalls) {
    const fn = (del.expression as ts.Identifier).text;
    const handlerFn = findNamedFunction(sourceFile, fn);
    if (!handlerFn) continue;
    const handlerBody = ts.isBlock(handlerFn.body!) ? handlerFn.body : handlerFn.body;
    if (!handlerBody) continue;
    const innerCalls = findCallExpressions(handlerBody, (c) => {
      const ifn = c.expression;
      if (ts.isIdentifier(ifn)) return ifn.text === "writeMutationReceipt" || ifn.text === "writeEffectReceipt";
      return false;
    });
    if (innerCalls.length > 0) return true;
  }

  return false;
}

function getToolCallSites(sourceFile: ts.SourceFile): Array<{ name: string; call: ts.CallExpression; body: ts.Node | null }> {
  const calls = findCallExpressions(sourceFile, (c) => {
    const fn = c.expression;
    return ts.isIdentifier(fn) && fn.text === "tool";
  });
  return calls
    .map((call) => {
      const name = getToolName(call);
      if (!name) return null;
      return { name, call, body: getHandlerBody(call) };
    })
    .filter((x): x is { name: string; call: ts.CallExpression; body: ts.Node | null } => x !== null);
}

// ---------------------------------------------------------------------------
// Load exclusions
// ---------------------------------------------------------------------------

interface ExclusionEntry {
  name: string;
  reason: string;
}

interface ExclusionsDoc {
  schema_version: number;
  description: string;
  tools: ExclusionEntry[];
}

let exclusions: string[] = [];

function loadExclusions() {
  const path = join(REPO_ROOT, "audit", "tool-receipt-exclusions.json");
  const raw = readFileSync(path, "utf8");
  const doc = JSON.parse(raw) as ExclusionsDoc;
  exclusions = doc.tools.map((t) => t.name);
  return exclusions;
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

const OUTBOUND_GATEWAY_CENTRALIZED = new Set(["send_to_channel", "dispatch_outbound_batch"]);
const TASK_DISPATCH_CENTRALIZED = new Set([
  "dispatch_task",
  "dispatch_to_role",
  "dispatch_by_requirements",
  "decompose_goal",
]);

type Classification = "excluded" | "outbound-gateway-centralized" | "task-dispatch-centralized" | "tool-local" | "MISSING";

interface ToolInstance {
  file: string;
  name: string;
  line: number;
  classification: Classification;
}

function classifyTool(name: string, body: ts.Node | null, sourceFile: ts.SourceFile): Classification {
  if (exclusions.includes(name)) return "excluded";
  if (OUTBOUND_GATEWAY_CENTRALIZED.has(name)) return "outbound-gateway-centralized";
  if (TASK_DISPATCH_CENTRALIZED.has(name)) return "task-dispatch-centralized";
  if (bodyContainsReceiptWrite(body, sourceFile)) return "tool-local";
  return "MISSING";
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export interface AuditResult {
  missing: ToolInstance[];
  staleExclusions: string[];
  allCovered: boolean;
}

export async function main(): Promise<AuditResult> {
  loadExclusions();

  const files = [
    join(REPO_ROOT, "src", "manager", "adam-tools.ts"),
    join(REPO_ROOT, "src", "manager", "execution-tools.ts"),
    join(REPO_ROOT, "src", "manager", "shared-tools.ts"),
  ];

  // Discover all tool instances across all 3 files
  const allInstances: ToolInstance[] = [];
  const discoveredNames = new Set<string>();

  for (const file of files) {
    const sourceFile = parseAst(file);
    const basename = file.replace(REPO_ROOT + "/", "");
    for (const { name, call, body } of getToolCallSites(sourceFile)) {
      const line = sourceFile.getLineAndCharacterOfPosition(call.getStart()).line + 1;
      const classification = classifyTool(name, body, sourceFile);
      allInstances.push({ file: basename, name, line, classification });
      discoveredNames.add(name);
    }
  }

  // Check stale exclusions: every exclusion name must correspond to at least one discovered tool
  const staleExclusions = exclusions.filter((name) => !discoveredNames.has(name));

  // Missing = not excluded, not centralized, not tool-local
  const missing = allInstances.filter((i) => i.classification === "MISSING");

  const allCovered = missing.length === 0 && staleExclusions.length === 0;

  // Console output
  if (!allCovered) {
    if (missing.length > 0) {
      console.error("[audit-tool-receipts] MISSING RECEIPT COVERAGE:");
      for (const m of missing) {
        console.error(`  - ${m.file}::${m.name} (line ${m.line}) — must call writeMutationReceipt or be added to exclusions`);
      }
    }
    if (staleExclusions.length > 0) {
      console.error("[audit-tool-receipts] STALE EXCLUSIONS:");
      for (const name of staleExclusions) {
        console.error(`  - ${name} — listed in exclusions but no tool by this name exists in any of the 3 files`);
      }
    }
  } else {
    const total = allInstances.length;
    console.log(`[audit-tool-receipts] All ${total} tools covered.`);
  }

  return { missing, staleExclusions, allCovered };
}

// ---------------------------------------------------------------------------
// CLI entry
// ---------------------------------------------------------------------------

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then(({ allCovered }) => {
    process.exit(allCovered ? 0 : 1);
  });
}

