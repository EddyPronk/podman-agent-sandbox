// What sandbox records about a sandbox, apart from podman: its kind (a VM sandbox stays one after
// sandbox rm) and its config folder. In $SANDBOX_DIR/.state/NAME.json, outside every mount: without
// --workspace, a sandbox's own folder is its workspace, writable inside, and an agent that could
// change the kind there could have the next enter run it as a plain container.
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { errnoCode, hasConfig, sandboxDir } from './devcontainer.js';
import { isObject, isString } from './json.js';

export type Kind = 'vm' | 'container';

/** NAME.json's contents. */
export interface StateRecord {
    kind: Kind;
    folder: string;
}

function isRecord(value: unknown): value is StateRecord {
    return isObject(value) && (value.kind === 'vm' || value.kind === 'container') && isString(value.folder);
}

/** Where NAME's record is. (.state can't be a sandbox's name: checkName.) */
export function recordPath(name: string, env: NodeJS.ProcessEnv = process.env): string {
    return join(sandboxDir(env), '.state', `${name}.json`);
}

/**
 * NAME's record, or null. A record whose config folder is gone (deleted by hand) counts as gone, and
 * is removed; so is one that can't be read.
 */
export function readRecord(name: string, { env = process.env }: { env?: NodeJS.ProcessEnv } = {}): StateRecord | null {
    const path = recordPath(name, env);
    let record: unknown;
    try {
        record = JSON.parse(readFileSync(path, 'utf8'));
    } catch (err) {
        if (errnoCode(err) === 'ENOENT') return null;
        rmSync(path, { force: true });
        return null;
    }
    if (!isRecord(record) || !hasConfig(record.folder)) {
        rmSync(path, { force: true });
        return null;
    }
    return { kind: record.kind, folder: record.folder };
}

/** Record NAME's KIND and config FOLDER (written whole, then renamed into place). */
export function writeRecord(name: string, { kind, folder }: StateRecord, env: NodeJS.ProcessEnv = process.env): void {
    const path = recordPath(name, env);
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify({ kind, folder }, null, 2)}\n`);
    renameSync(tmp, path);
}

/** Forget NAME's record. */
export function removeRecord(name: string, env: NodeJS.ProcessEnv = process.env): void {
    rmSync(recordPath(name, env), { force: true });
}
