/** Deeply redact payment identifiers and amounts without mutating caller data. */
export function redactReconcileLog<T extends Record<string, unknown>>(obj: T): T {
  const seen = new WeakMap<object, unknown>();
  const visit = (value: unknown): unknown => {
    if (value === null || typeof value !== 'object') return value;
    if (seen.has(value)) return seen.get(value);
    if (value instanceof Date) return value.toISOString();
    const result: Record<string, unknown> | unknown[] = Array.isArray(value) ? [] : {};
    seen.set(value, result);
    if (Array.isArray(value)) {
      for (const item of value) (result as unknown[]).push(visit(item));
    } else {
      for (const [key, child] of Object.entries(value)) {
        const lk = key.toLowerCase();
        if (lk.includes('merchantid') || lk.includes('merchant_id') || lk.includes('accountid')) {
          (result as Record<string, unknown>)[key] = typeof child === 'string' ? `${child.slice(0, 4)}***` : '[REDACTED]';
        } else if (['amount', 'diff', 'gross', 'fee', 'net'].some((token) => lk.includes(token))) {
          (result as Record<string, unknown>)[key] = '[REDACTED]';
        } else {
          (result as Record<string, unknown>)[key] = visit(child);
        }
      }
    }
    return result;
  };
  return visit(obj) as T;
}
