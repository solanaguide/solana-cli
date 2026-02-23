export interface CommandResult<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
  message?: string;
  meta?: { elapsed_ms: number; [key: string]: unknown };
}

export function success<T>(data: T, meta?: Record<string, unknown>): CommandResult<T> {
  return { ok: true, data, meta: { elapsed_ms: 0, ...meta } };
}

export function failure(error: string, message: string, data?: unknown): CommandResult {
  return { ok: false, error, message, ...(data ? { data } : {}) };
}

let jsonMode = false;
let verboseMode = false;

export function setJsonMode(enabled: boolean) { jsonMode = enabled; }
export function setVerboseMode(enabled: boolean) { verboseMode = enabled; }
export function isJsonMode() { return jsonMode; }
export function isVerboseMode() { return verboseMode; }

export function output<T>(result: CommandResult<T>) {
  if (jsonMode) {
    console.log(JSON.stringify(result, null, 2));
  } else if (result.ok) {
    // Human-readable output — handled by individual commands
    // This is a fallback for commands that don't format their own output
    if (result.data !== undefined) {
      if (typeof result.data === 'string') {
        console.log(result.data);
      } else {
        console.log(JSON.stringify(result.data, null, 2));
      }
    }
  } else {
    console.error(`Error: ${result.message || result.error}`);
  }
}

export function outputRaw(text: string) {
  if (!jsonMode) {
    console.log(text);
  }
}

export function warn(message: string) {
  if (!jsonMode) {
    console.error(`Warning: ${message}`);
  }
}

export function verbose(message: string) {
  if (verboseMode && !jsonMode) {
    console.error(`[verbose] ${message}`);
  }
}

/** Format a USD price with enough decimals to show meaningful digits.
 *  $80.60, $0.0061, $0.00000012 — never shows $0.0000 for non-zero prices. */
export function fmtPrice(price: number): string {
  if (price >= 1) return price.toFixed(2);
  if (price >= 0.01) return price.toFixed(4);
  // For tiny prices, show 2 significant digits
  if (price > 0) {
    const digits = -Math.floor(Math.log10(price)) + 1;
    return price.toFixed(Math.min(digits, 12));
  }
  return '0.00';
}

export function timed<T>(fn: () => T | Promise<T>): Promise<{ result: T; elapsed_ms: number }> {
  const start = performance.now();
  const maybePromise = fn();
  if (maybePromise instanceof Promise) {
    return maybePromise.then(result => ({
      result,
      elapsed_ms: Math.round(performance.now() - start),
    }));
  }
  return Promise.resolve({
    result: maybePromise,
    elapsed_ms: Math.round(performance.now() - start),
  });
}
