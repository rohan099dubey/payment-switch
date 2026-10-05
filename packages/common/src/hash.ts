import { createHash } from 'node:crypto';

/**
 * Deterministic JSON: object keys sorted by UTF-16 code unit, no whitespace. Used for
 * request hashes, so two semantically equal bodies must serialize identically and two
 * different bodies must never collide.
 *
 * Stricter than JSON.stringify on purpose:
 * - `bigint` is written as a bare JSON number (`12500`), never as a string, so the
 *   amount `12500n` and the string `"12500"` hash differently.
 * - Non-finite numbers, functions, symbols, cycles, and non-plain objects (Map, Set,
 *   class instances without `toJSON`) throw instead of being silently dropped or
 *   flattened to `{}`.
 * - Object properties whose value is `undefined` are omitted, as in JSON.stringify.
 */
export function canonicalJson(value: unknown): string {
  return serialize(value, new Set<object>());
}

function serialize(value: unknown, seen: Set<object>): string {
  if (value === null) return 'null';

  switch (typeof value) {
    case 'string':
      return JSON.stringify(value);
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) {
        throw new TypeError(`canonicalJson: non-finite number ${String(value)}`);
      }
      return JSON.stringify(value);
    case 'bigint':
      return value.toString(10);
    case 'undefined':
    case 'function':
    case 'symbol':
      throw new TypeError(`canonicalJson: cannot serialize a value of type ${typeof value}`);
    case 'object':
      return serializeObject(value, seen);
  }
  throw new TypeError(`canonicalJson: unsupported type ${typeof value}`);
}

function serializeObject(value: object, seen: Set<object>): string {
  if (seen.has(value)) throw new TypeError('canonicalJson: circular reference');

  if (hasToJson(value)) {
    seen.add(value);
    try {
      return serialize(value.toJSON(), seen);
    } finally {
      seen.delete(value);
    }
  }

  seen.add(value);
  try {
    if (Array.isArray(value)) {
      const items = value.map((item: unknown) => (item === undefined ? 'null' : serialize(item, seen)));
      return `[${items.join(',')}]`;
    }

    const proto: unknown = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) {
      throw new TypeError('canonicalJson: only plain objects, arrays and toJSON objects are supported');
    }

    const record = value as Record<string, unknown>;
    const parts: string[] = [];
    for (const key of Object.keys(record).sort()) {
      const item = record[key];
      if (item === undefined) continue;
      parts.push(`${JSON.stringify(key)}:${serialize(item, seen)}`);
    }
    return `{${parts.join(',')}}`;
  } finally {
    seen.delete(value);
  }
}

function hasToJson(value: object): value is { toJSON: () => unknown } {
  return typeof (value as { toJSON?: unknown }).toJSON === 'function';
}

export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}
