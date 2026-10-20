// json.ts's checks, at run time and at compile time: the narrowing tests below don't build (tsc -p
// test, in pretest) if a check stops narrowing what it accepts.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isBoolean, isNumber, isObject, isString, isStringList, nullable, optional } from '../dist/json.js';
import type { JsonObject } from '../dist/json.js';

test('isObject: an object, not null, not a list', () => {
    assert.ok(isObject({}));
    assert.ok(isObject({ a: 1 }));
    for (const value of [null, [], 'x', 1, true, undefined]) assert.ok(!isObject(value), String(value));
});

test('isStringList: a list of strings, nothing else in it', () => {
    assert.ok(isStringList([]));
    assert.ok(isStringList(['a', 'b']));
    for (const value of [['a', 1], [null], 'a', null, {}]) assert.ok(!isStringList(value), JSON.stringify(value));
});

test('isString, isNumber, isBoolean: the JSON types, by typeof', () => {
    assert.ok(isString('') && !isString(1) && !isString(null));
    assert.ok(isNumber(0) && !isNumber('0') && !isNumber(null));
    assert.ok(isBoolean(false) && !isBoolean(0) && !isBoolean('true'));
});

test('optional takes a missing value but not null; nullable takes both', () => {
    assert.ok(optional(undefined, isString) && optional('a', isString));
    assert.ok(!optional(null, isString) && !optional(1, isString));
    assert.ok(nullable(undefined, isString) && nullable(null, isString) && nullable('a', isString));
    assert.ok(!nullable(1, isString));
});

test('the checks narrow what they accept (a compile-time test)', () => {
    const parsed: unknown = JSON.parse('{"names": ["a"], "label": null}');
    // Each assignment below is to a narrowed type: it compiles only if the check narrows.
    const fields: JsonObject = isObject(parsed) ? parsed : assert.fail('not an object');
    const names: string[] | null | undefined = nullable(fields.names, isStringList) ? fields.names : assert.fail('names');
    const label: string | null | undefined = nullable(fields.label, isString) ? fields.label : assert.fail('label');
    const missing: string | undefined = optional(fields.missing, isString) ? fields.missing : assert.fail('missing');
    assert.deepEqual([names, label, missing], [['a'], null, undefined]);
});
