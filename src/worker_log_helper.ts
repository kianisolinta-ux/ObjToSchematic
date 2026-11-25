export interface WorkerLogFormatOptions {
    maxStringLength?: number;
    maxArrayPreview?: number;
    maxObjectKeys?: number;
    maxDepth?: number;
    maxOutputLength?: number;
}

const DEFAULT_MAX_STRING_LENGTH = 160;
const DEFAULT_MAX_ARRAY_PREVIEW = 6;
const DEFAULT_MAX_OBJECT_KEYS = 24;
const DEFAULT_MAX_DEPTH = 4;
const DEFAULT_MAX_OUTPUT_LENGTH = 4000;

function sanitizeForLog(
    value: unknown,
    depth: number,
    seen: WeakSet<object>,
    opts: Required<WorkerLogFormatOptions>,
): unknown {
    if (value === null || value === undefined) {
        return value;
    }

    const type = typeof value;
    if (type === 'boolean') {
        return value;
    }
    if (type === 'number') {
        return Number.isFinite(value as number) ? value : String(value);
    }
    if (type === 'bigint') {
        return `${String(value)}n`;
    }
    if (type === 'symbol' || type === 'function') {
        return `[${type}]`;
    }
    if (type === 'string') {
        const str = value as string;
        if (str.length > opts.maxStringLength) {
            return `${str.slice(0, Math.min(64, opts.maxStringLength))}... [string(${str.length})]`;
        }
        return str;
    }

    if (typeof value !== 'object') {
        return String(value);
    }

    const obj = value as object;
    if (seen.has(obj)) {
        return '[Circular]';
    }

    if (obj instanceof ArrayBuffer) {
        return `[ArrayBuffer(${obj.byteLength})]`;
    }

    if (ArrayBuffer.isView(obj)) {
        const name = obj.constructor?.name || 'TypedArray';
        const length = 'length' in obj ? (obj as { length: number }).length : obj.byteLength;
        return `[${name}(${length})]`;
    }

    if (typeof Blob !== 'undefined' && obj instanceof Blob) {
        const fileName = 'name' in obj && typeof (obj as { name?: unknown }).name === 'string' ?
            ` name=${(obj as { name: string }).name}` :
            '';
        const mime = obj.type ? ` type=${obj.type}` : '';
        return `[Blob${fileName} size=${obj.size}${mime}]`;
    }

    if (obj instanceof Date) {
        return obj.toISOString();
    }

    if (depth >= opts.maxDepth) {
        if (Array.isArray(obj)) {
            return `[Array(${obj.length})]`;
        }
        if (obj instanceof Map) {
            return `[Map(${obj.size})]`;
        }
        if (obj instanceof Set) {
            return `[Set(${obj.size})]`;
        }
        const ctor = obj.constructor?.name;
        return ctor && ctor !== 'Object' ? `[${ctor}]` : '[Object]';
    }

    seen.add(obj);
    try {
        if (Array.isArray(obj)) {
            if (obj.length > opts.maxArrayPreview) {
                const preview = obj
                    .slice(0, opts.maxArrayPreview)
                    .map((item) => sanitizeForLog(item, depth + 1, seen, opts));
                preview.push(`... (+${obj.length - opts.maxArrayPreview} more, total ${obj.length})`);
                return preview;
            }
            return obj.map((item) => sanitizeForLog(item, depth + 1, seen, opts));
        }

        if (obj instanceof Map) {
            const entries: Record<string, unknown> = {};
            let count = 0;
            obj.forEach((v, k) => {
                if (count < opts.maxObjectKeys) {
                    entries[String(k)] = sanitizeForLog(v, depth + 1, seen, opts);
                    count++;
                } else if (entries['__truncated__'] === undefined) {
                    entries['__truncated__'] = `... (+${obj.size - count} more entries, total ${obj.size})`;
                }
            });
            return {
                __type: `Map(${obj.size})`,
                entries,
            };
        }

        if (obj instanceof Set) {
            const items: unknown[] = [];
            let count = 0;
            let truncated = false;
            obj.forEach((item) => {
                if (count < opts.maxArrayPreview) {
                    items.push(sanitizeForLog(item, depth + 1, seen, opts));
                    count++;
                } else if (!truncated) {
                    truncated = true;
                    items.push(`... (+${obj.size - count} more, total ${obj.size})`);
                }
            });
            return {
                __type: `Set(${obj.size})`,
                values: items,
            };
        }

        const out: Record<string, unknown> = {};
        const keys = Object.keys(obj);
        const limit = Math.min(keys.length, opts.maxObjectKeys);
        for (let i = 0; i < limit; i++) {
            const key = keys[i];
            out[key] = sanitizeForLog((obj as Record<string, unknown>)[key], depth + 1, seen, opts);
        }
        if (keys.length > opts.maxObjectKeys) {
            out['__truncatedKeys__'] = `... (+${keys.length - opts.maxObjectKeys} more keys)`;
        }
        return out;
    } finally {
        seen.delete(obj);
    }
}

/**
 * Formats an arbitrary worker payload into a bounded, readable string for debug logging.
 * Never throws RangeError / TypeError on huge meshes, textures, typed arrays, or circular refs.
 */
export function formatWorkerPayloadForLog(
    payload: unknown,
    options?: WorkerLogFormatOptions,
): string {
    const opts: Required<WorkerLogFormatOptions> = {
        maxStringLength: options?.maxStringLength ?? DEFAULT_MAX_STRING_LENGTH,
        maxArrayPreview: options?.maxArrayPreview ?? DEFAULT_MAX_ARRAY_PREVIEW,
        maxObjectKeys: options?.maxObjectKeys ?? DEFAULT_MAX_OBJECT_KEYS,
        maxDepth: options?.maxDepth ?? DEFAULT_MAX_DEPTH,
        maxOutputLength: options?.maxOutputLength ?? DEFAULT_MAX_OUTPUT_LENGTH,
    };

    try {
        const sanitized = sanitizeForLog(payload, 0, new WeakSet<object>(), opts);
        const serialized = JSON.stringify(sanitized, null, 4) ?? String(sanitized);
        if (serialized.length > opts.maxOutputLength) {
            return `${serialized.slice(0, opts.maxOutputLength)}\n... (truncated, ${serialized.length} chars total)`;
        }
        return serialized;
    } catch (err) {
        const action = payload && typeof payload === 'object' && 'action' in payload ?
            String((payload as { action?: unknown }).action) :
            'unknown';
        return `[Unserializable payload action=${action}: ${err instanceof Error ? err.message : String(err)}]`;
    }
}
