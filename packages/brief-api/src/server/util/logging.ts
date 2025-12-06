// src/server/util/logging.ts

/**
 * Hilfsfunktion zum sicheren Loggen großer JSON-Objekte.
 */
export function truncateLongJson(input: any, maxLength = 5000): string {
  let str = '';

  try {
    str = typeof input === 'string' ? input : JSON.stringify(input, null, 2);
  } catch (err) {
    return '[UNSERIALIZABLE JSON]';
  }

  if (str.length > maxLength) {
    return str.substring(0, maxLength) + `... [truncated ${str.length - maxLength} chars]`;
  }
  return str;
}

/**
 * Standardisiertes Logging, das große Objekte automatisch kürzt.
 */
export function prettyLog(prefix: string, obj: any) {
  console.log(prefix, truncateLongJson(obj));
}

/**
 * Fehlerlogging mit erweiterter Darstellung.
 */
export function logError(prefix: string, error: any) {
  console.error(prefix, {
    message: error?.message,
    stack: error?.stack,
    details: error?.details ?? null,
  });
}