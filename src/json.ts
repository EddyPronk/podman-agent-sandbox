// Checks for JSON that sandbox reads from disk (configs, template metadata, records): parsed as
// unknown, then narrowed by these before use.

/** A JSON object's fields, each still to be checked. */
export type JsonObject = { [field: string]: unknown };

/** A JSON object: not null, not a list. */
export function isObject(value: unknown): value is JsonObject {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A list of strings. */
export function isStringList(value: unknown): value is string[] {
    return Array.isArray(value) && value.every((item) => typeof item === 'string');
}
