// @ts-check
// What sandbox records about a sandbox, apart from podman: its kind (a VM sandbox stays one after
// sandbox rm) and its config folder. In $SANDBOX_DIR/.state/NAME.json, outside every mount: without
// --workspace, a sandbox's own folder is its workspace, writable inside, and an agent that could
// change the kind there could have the next enter run it as a plain container.
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { hasConfig, sandboxDir } from './devcontainer.js';

/**
 * @typedef {'vm' | 'container'} Kind
 * @typedef {{ kind: Kind, folder: string }} Record
 */

/**
 * Where NAME's record is. (.state can't be a sandbox's name: checkName.)
 * @param {string} name
 * @param {NodeJS.ProcessEnv} [env]
 */
export function recordPath(name, env = process.env) {
    return join(sandboxDir(env), '.state', `${name}.json`);
}

/**
 * NAME's record, or null. A record whose config folder is gone (deleted by hand) counts as gone, and
 * is removed; so is one that can't be read.
 * @param {string} name
 * @param {{ env?: NodeJS.ProcessEnv }} [options]
 * @returns {Record | null}
 */
export function readRecord(name, { env = process.env } = {}) {
    const path = recordPath(name, env);
    let record;
    try {
        record = JSON.parse(readFileSync(path, 'utf8'));
    } catch (err) {
        if (/** @type {NodeJS.ErrnoException} */ (err).code === 'ENOENT') return null;
        rmSync(path, { force: true });
        return null;
    }
    const valid = record && (record.kind === 'vm' || record.kind === 'container') && typeof record.folder === 'string';
    if (!valid || !hasConfig(record.folder)) {
        rmSync(path, { force: true });
        return null;
    }
    return { kind: record.kind, folder: record.folder };
}

/**
 * Record NAME's KIND and config FOLDER (written whole, then renamed into place).
 * @param {string} name
 * @param {Record} record
 * @param {NodeJS.ProcessEnv} [env]
 */
export function writeRecord(name, { kind, folder }, env = process.env) {
    const path = recordPath(name, env);
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify({ kind, folder }, null, 2)}\n`);
    renameSync(tmp, path);
}

/**
 * Forget NAME's record.
 * @param {string} name
 * @param {NodeJS.ProcessEnv} [env]
 */
export function removeRecord(name, env = process.env) {
    rmSync(recordPath(name, env), { force: true });
}
