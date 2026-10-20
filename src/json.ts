// Checks for JSON that sandbox reads from disk (configs, template metadata, records) or from other
// programs (podman, the Dev Containers CLI): parsed as unknown, then narrowed by these before use.

/** A JSON object's fields, each still to be checked. */
export type JsonObject = { [field: string]: unknown };

/** A check of one JSON value. */
export type Check = (value: unknown) => boolean;

/** A JSON object: not null, not a list. */
export function isObject(value: unknown): value is JsonObject {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A list of strings. */
export function isStringList(value: unknown): value is string[] {
    return Array.isArray(value) && value.every(isString);
}

export function isString(value: unknown): value is string {
    return typeof value === 'string';
}

export function isNumber(value: unknown): value is number {
    return typeof value === 'number';
}

export function isBoolean(value: unknown): value is boolean {
    return typeof value === 'boolean';
}

/** Missing, or what CHECK accepts: for fields sandbox writes itself, which it never sets to null. */
export function optional(value: unknown, check: Check): boolean {
    return value === undefined || check(value);
}

/**
 * Missing, null, or what CHECK accepts: for fields others write. The Dev Containers CLI reads null
 * as unset, and Go (podman) writes an empty list or map as null.
 */
export function nullable(value: unknown, check: Check): boolean {
    return value === undefined || value === null || check(value);
}
