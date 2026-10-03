// Helpers around the Dev Containers CLI and Podman.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/** An error meant for the user: printed as "sandbox: <message>", no stack trace. */
export class SandboxError extends Error {}

/** Where sandboxes live: $SANDBOX_DIR, or ~/sandboxes. */
export function sandboxDir(env = process.env) {
    return env.SANDBOX_DIR || join(homedir(), 'sandboxes');
}

// Container names double as folder names, so keep them to what Podman accepts
// and rule out path tricks like "../x".
const NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;

export function checkName(name) {
    if (!name) throw new SandboxError('missing NAME');
    if (!NAME.test(name)) throw new SandboxError(`invalid name '${name}' (use letters, digits, '_', '.', '-')`);
    return name;
}

// The pinned @devcontainers/cli from our own dependencies, not whatever is on PATH.
const require = createRequire(import.meta.url);
export function cliPath() {
    return join(dirname(require.resolve('@devcontainers/cli/package.json')), 'devcontainer.js');
}

// Numeric IDs for containerUser: Podman can't resolve $USER by name before keep-id adds it.
function childEnv() {
    return { ...process.env, SANDBOX_UID: String(process.getuid()), SANDBOX_GID: String(process.getgid()) };
}

/** Run `devcontainer SUB --docker-path podman ARGS`. The CLI only parses options placed after the subcommand. */
export function dc(sub, args, options = {}) {
    const result = spawnSync(process.execPath, [cliPath(), sub, '--docker-path', 'podman', ...args],
        { env: childEnv(), stdio: 'inherit', ...options });
    if (result.error) throw result.error;
    return result;
}

/** Run podman and capture its output. */
export function podman(args) {
    const result = spawnSync('podman', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    if (result.error?.code === 'ENOENT') throw new SandboxError('podman not found on PATH');
    if (result.error) throw result.error;
    return result;
}

function inspect(name, format) {
    const result = podman(['container', 'inspect', '--format', format, name]);
    const out = result.status === 0 ? result.stdout.trim() : '';
    return out === '<no value>' ? '' : out;
}

/** The workspace folder recorded on container NAME, or '' if there is none. */
export function labelFolder(name) {
    return inspect(name, '{{index .Config.Labels "devcontainer.local_folder"}}');
}

/** 'running', 'exited', ... or '' if container NAME does not exist. */
export function containerState(name) {
    return inspect(name, '{{.State.Status}}');
}

export function hasConfig(dir) {
    return existsSync(join(dir, '.devcontainer', 'devcontainer.json')) || existsSync(join(dir, '.devcontainer.json'));
}

/** Resolve NAME to its workspace folder: the container's label, or else $SANDBOX_DIR/NAME. */
export function folderOf(name, { lookup = labelFolder, env = process.env } = {}) {
    checkName(name);
    const dir = lookup(name) || join(sandboxDir(env), name);
    if (!hasConfig(dir)) {
        throw new SandboxError(`no container or dev container config named '${name}' (looked in ${dir})`);
    }
    return dir;
}
