// Checks for JSON that sandbox reads from disk (configs, template metadata, records) or from other
// programs (podman, the Dev Containers CLI): parsed as unknown, then narrowed by these before use.

/** A JSON object's fields, each still to be checked. */
export type JsonObject = { [field: string]: unknown };

/** A check of one JSON value, which narrows it to T. */
export type Check<T> = (value: unknown) => value is T;

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

/** Missing, or what CHECK accepts. */
export function optional<T>(value: unknown, check: Check<T>): value is T | undefined {
    return value === undefined || check(value);
}

/**
 * Missing, null, or what CHECK accepts. Which fields may be null is the caller's to say, with why:
 * json.ts doesn't know who wrote the value.
 */
export function nullable<T>(value: unknown, check: Check<T>): value is T | null | undefined {
    return value === undefined || value === null || check(value);
}
