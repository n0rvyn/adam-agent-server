// ---------------------------------------------------------------------------
// Public error classes — exported from src/validators/index.ts as the module API
// ---------------------------------------------------------------------------

function formatValue(v: number | string | boolean): string {
  if (typeof v === "number") return Number.isInteger(v) ? v.toString() : v.toFixed(4);
  return JSON.stringify(v);
}

export class NoHandlerError extends Error {
  constructor(public readonly handlerKey: string) {
    super(`NO_HANDLER: ${handlerKey}, install relevant capability or remove assertion`);
    this.name = "NoHandlerError";
  }
}

export class AssertionFailedError extends Error {
  constructor(
    public readonly handlerKey: string,
    public readonly measured: number | string | boolean,
    public readonly expected: string,
  ) {
    super(`ASSERTION_FAILED: ${handlerKey}=${formatValue(measured)}, expected ${expected}`);
    this.name = "AssertionFailedError";
  }
}

export class HandlerRuntimeError extends Error {
  constructor(public readonly handlerKey: string, public readonly detail: string) {
    super(`HANDLER_RUNTIME_ERROR: ${handlerKey}: ${detail}`);
    this.name = "HandlerRuntimeError";
  }
}
