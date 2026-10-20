// A lock per sandbox, so that two sandbox commands on one sandbox (your own terminals) don't race:
// both creating its container, one stopping it while the other starts it. Not a security boundary:
// VS Code and plain podman don't take it.
import { spawnSync } from 'node:child_process';
import { closeSync, fstatSync, mkdirSync, openSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { SandboxError, sandboxDir } from './devcontainer.js';

// What flock exits with when the lock is taken (--nonblock); its other errors use other codes.
const CONFLICT = 75;

/**
 * Where NAME's lock is: $SANDBOX_DIR/.locks/NAME. Not in the sandbox's config folder: for a sandbox
 * made from a template without --workspace that folder is the workspace, mounted read-write inside,
 * so the agent could hold the lock. No container mounts $SANDBOX_DIR itself, and no sandbox can be
 * called .locks (checkName).
 */
export function lockPath(name: string, env: NodeJS.ProcessEnv = process.env): string {
    return join(sandboxDir(env), '.locks', name);
}

/**
 * Release a lock; with REMOVE, delete its file first (a command that found no such sandbox), while
 * still holding it.
 */
export type Release = (options?: { remove?: boolean }) => void;

/**
 * Take NAME's lock, waiting (and saying so) while another command holds it. util-linux flock locks a
 * file descriptor Node opened and passes it as fd 3: the lock belongs to that open file, so it stays
 * held after flock exits, until the returned function closes it, or the OS does when sandbox exits.
 * The holder may delete the file (Release); a command that waited for it then holds a lock on a file
 * no one else can open, so it checks that PATH is still the file it locked, and else locks again.
 * Returns the Release for the lock; calling it again does nothing.
 */
export function lockSandbox(name: string, {
    env = process.env,
    waiting = (n) => console.error(`sandbox: waiting for another sandbox command on ${n} ...`),
}: { env?: NodeJS.ProcessEnv; waiting?: (name: string) => void } = {}): Release {
    const path = lockPath(name, env);
    let told = false;
    for (;;) {
        mkdirSync(dirname(path), { recursive: true });
        const fd = openSync(path, 'a');
        const flock = (args: string[]) => spawnSync('flock', [...args, '3'], { encoding: 'utf8', stdio: ['ignore', 'ignore', 'pipe', fd] });
        try {
            let result = flock(['--exclusive', '--nonblock', '--conflict-exit-code', String(CONFLICT)]);
            if (result.error && 'code' in result.error && result.error.code === 'ENOENT') {
                throw new SandboxError('flock not found on PATH: sandbox needs it (from util-linux) to keep two commands '
                    + 'on one sandbox apart');
            }
            if (result.error) throw result.error;
            if (result.status === CONFLICT) {
                if (!told) waiting(name);
                told = true;
                result = flock(['--exclusive']);
            }
            if (result.status !== 0) throw new SandboxError(`can't lock ${path}: ${result.stderr.trim()}`);
        } catch (err) {
            closeSync(fd);
            throw err;
        }
        if (!sameFile(fd, path)) {
            closeSync(fd);
            continue;
        }
        let held = true;
        return ({ remove = false } = {}) => {
            if (!held) return;
            held = false;
            try {
                if (remove) rmSync(path, { force: true });
            } finally {
                closeSync(fd);
            }
        };
    }
}

/** Whether PATH is the file open as FD (it may have been deleted, or replaced by a new one). */
function sameFile(fd: number, path: string): boolean {
    try {
        const open = fstatSync(fd);
        const now = statSync(path);
        return open.dev === now.dev && open.ino === now.ino;
    } catch {
        return false;
    }
}
