// @ts-check
// A lock per sandbox, so that two sandbox commands on one sandbox (your own terminals) don't race:
// both creating its container, one stopping it while the other starts it. Not a security boundary:
// VS Code and plain podman don't take it.
import { spawnSync } from 'node:child_process';
import { closeSync, mkdirSync, openSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { SandboxError, sandboxDir } from './devcontainer.js';

// What flock exits with when the lock is taken (--nonblock); its other errors use other codes.
const CONFLICT = 75;

/**
 * Where NAME's lock is: $SANDBOX_DIR/.locks/NAME. Not in the sandbox's config folder: for a sandbox
 * made from a template without --workspace that folder is the workspace, mounted read-write inside,
 * so the agent could hold the lock. No container mounts $SANDBOX_DIR itself, and no sandbox can be
 * called .locks (checkName).
 * @param {string} name
 * @param {NodeJS.ProcessEnv} [env]
 */
export function lockPath(name, env = process.env) {
    return join(sandboxDir(env), '.locks', name);
}

/**
 * Take NAME's lock, waiting (and saying so) while another command holds it. util-linux flock locks a
 * file descriptor Node opened and passes it as fd 3: the lock belongs to that open file, so it stays
 * held after flock exits, until the returned function closes it, or the OS does when sandbox exits.
 * @param {string} name
 * @param {{ env?: NodeJS.ProcessEnv, waiting?: (name: string) => void }} [options]
 * @returns {() => void} releases the lock; calling it again does nothing
 */
export function lockSandbox(name, {
    env = process.env,
    waiting = (n) => console.error(`sandbox: waiting for another sandbox command on ${n} ...`),
} = {}) {
    const path = lockPath(name, env);
    mkdirSync(dirname(path), { recursive: true });
    const fd = openSync(path, 'a');
    /** @param {string[]} args */
    const flock = (args) => spawnSync('flock', [...args, '3'], { encoding: 'utf8', stdio: ['ignore', 'ignore', 'pipe', fd] });
    try {
        let result = flock(['--exclusive', '--nonblock', '--conflict-exit-code', String(CONFLICT)]);
        if (result.error && /** @type {NodeJS.ErrnoException} */ (result.error).code === 'ENOENT') {
            throw new SandboxError('flock not found on PATH: sandbox needs it (from util-linux) to keep two commands '
                + 'on one sandbox apart');
        }
        if (result.error) throw result.error;
        if (result.status === CONFLICT) {
            waiting(name);
            result = flock(['--exclusive']);
        }
        if (result.status !== 0) throw new SandboxError(`can't lock ${path}: ${result.stderr.trim()}`);
    } catch (err) {
        closeSync(fd);
        throw err;
    }
    let held = true;
    return () => {
        if (!held) return;
        held = false;
        closeSync(fd);
    };
}
