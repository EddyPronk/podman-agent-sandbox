// Helpers around the Dev Containers CLI and Podman.
import { spawnSync } from 'node:child_process';
import type { SpawnSyncOptions, SpawnSyncReturns } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { constants, homedir, userInfo } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { isObject, isString } from './json.js';

/** An error meant for the user: printed as "sandbox: <message>", no stack trace. */
export class SandboxError extends Error {}

/** The code of a Node.js error (ENOENT, EACCES, ERR_PARSE_ARGS_…), or undefined for anything else. */
export function errnoCode(err: unknown): string | undefined {
    return err instanceof Error && 'code' in err && typeof err.code === 'string' ? err.code : undefined;
}

/** Where sandboxes live: $SANDBOX_DIR, or ~/sandboxes. */
export function sandboxDir(env: NodeJS.ProcessEnv = process.env): string {
    return env.SANDBOX_DIR || join(homedir(), 'sandboxes');
}

// Container names double as folder names, so keep them to what Podman accepts
// and rule out path tricks like "../x".
const NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;

export function checkName(name: string): string {
    if (!name) throw new SandboxError('missing NAME');
    if (!NAME.test(name)) throw new SandboxError(`invalid name '${name}' (use letters, digits, '_', '.', '-')`);
    return name;
}

// The pinned @devcontainers/cli from our own dependencies, not whatever is on PATH.
const require = createRequire(import.meta.url);
export function cliPath(): string {
    return join(dirname(require.resolve('@devcontainers/cli/package.json')), 'devcontainer.js');
}

/** The version in the package.json FILE. */
export function packageVersion(file: string | URL): string {
    const pkg: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (isObject(pkg) && isString(pkg.version)) return pkg.version;
    throw new Error(`${file} has no version`);
}

export const PACKAGE_VERSION = packageVersion(new URL('../package.json', import.meta.url));

/**
 * The Dev Containers CLI's environment. Templates read it through ${localEnv:…}:
 * - USER (home volume path, remoteUser): set from the user database when missing, as it is in a
 *   container, under cron or systemd; a login sets it, nothing else does.
 * - SANDBOX_UID/SANDBOX_GID: numeric IDs for containerUser; Podman can't resolve $USER by name
 *   before keep-id adds it.
 * - SANDBOX_VERSION: this package's version, so a template that installs sandbox inside the
 *   sandbox (claude-containers) installs the same one.
 */
export function childEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
    // getuid and getgid exist on every POSIX system; only Windows lacks them.
    const child: NodeJS.ProcessEnv = {
        ...env,
        SANDBOX_UID: String(process.getuid!()),
        SANDBOX_GID: String(process.getgid!()),
        SANDBOX_VERSION: PACKAGE_VERSION,
    };
    if (!child.USER) {
        try {
            child.USER = userInfo().username;
        } catch {
            // No entry in the user database: leave USER unset, as before.
        }
    }
    return child;
}

/**
 * Run `devcontainer SUB --docker-path podman ARGS`. The CLI only parses options placed after the subcommand.
 * Its output is a string or a Buffer, depending on OPTIONS' encoding.
 */
export function dc(sub: string, args: string[], options: SpawnSyncOptions = {}): SpawnSyncReturns<string | Buffer> {
    const result = spawnSync(process.execPath, [cliPath(), sub, '--docker-path', 'podman', ...args],
        { env: childEnv(), stdio: 'inherit', ...options });
    if (result.error) throw result.error;
    return result;
}

/**
 * Run podman and capture its output; OPTIONS for spawnSync replace that (e.g. { stdio: 'inherit' } for
 * podman attach). Every podman call goes through here, so a missing podman is reported the same way.
 */
export function podman(args: string[], options: Omit<SpawnSyncOptions, 'encoding'> = {}): SpawnSyncReturns<string> {
    const result = spawnSync('podman', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options });
    if (errnoCode(result.error) === 'ENOENT') {
        throw new SandboxError('podman not found on PATH');
    }
    if (result.error) throw result.error;
    return result;
}

/** A child's exit status the way a shell reports it. */
export function exitStatus(result: Pick<SpawnSyncReturns<unknown>, 'status' | 'signal'>): number {
    return result.status ?? 128 + (result.signal ? constants.signals[result.signal] ?? 0 : 0);
}

function inspect(name: string, format: string): string {
    const result = podman(['container', 'inspect', '--format', format, name]);
    const out = result.status === 0 ? result.stdout.trim() : '';
    return out === '<no value>' ? '' : out;
}

/** The label the bundled templates put on every sandbox's container, with the sandbox version. */
export const SANDBOX_LABEL = 'podman-agent-sandbox';

/**
 * Whether a container is a sandbox: only its SANDBOX_LABEL (LABEL, the value) says so; the bundled
 * templates add it since 0.6.0. Returns how it was recognised, or '' when it isn't.
 */
export function sandboxReason({ label = '' }: { label?: string }): string {
    return label ? `label ${SANDBOX_LABEL}=${label}` : '';
}

/**
 * For a container without the label: what its config folder (FOLDER, the devcontainer.local_folder
 * label) suggests, or ''. A folder in $SANDBOX_DIR, or with a sandbox.json, looks like a sandbox
 * made before 0.6.0, but only says where a config lives: VS Code made one there too.
 */
export function unlabelledHint(
    { folder = '' }: { folder?: string },
    { env = process.env, exists = existsSync }: { env?: NodeJS.ProcessEnv; exists?: (path: string) => boolean } = {},
): string {
    if (!folder || !hasConfig(folder, exists)) return '';
    if (resolve(dirname(folder)) === resolve(sandboxDir(env))) return `its config folder is in ${sandboxDir(env)}`;
    if (exists(join(folder, 'sandbox.json'))) return 'its config folder has a sandbox.json';
    return '';
}

/** How a container is (or may be) recognised as a sandbox: sandboxReason, else unlabelledHint. */
export interface SandboxSigns {
    reason: string;
    hint: string;
}

/** For container NAME: { reason, hint } (sandboxReason, unlabelledHint); null when there's no such container. */
export function containerSandbox(name: string): SandboxSigns | null {
    const out = inspect(name, `{{index .Config.Labels "${SANDBOX_LABEL}"}}|{{index .Config.Labels "devcontainer.local_folder"}}`);
    if (!out) return null;
    const [label, folder] = out.split('|').map((s) => (s === '<no value>' ? '' : s));
    const reason = sandboxReason({ label });
    return { reason, hint: reason ? '' : unlabelledHint({ folder }) };
}

/** The workspace folder recorded on container NAME, or '' if there is none. */
export function labelFolder(name: string): string {
    return inspect(name, '{{index .Config.Labels "devcontainer.local_folder"}}');
}

/** 'running', 'exited', ... or '' if container NAME does not exist. */
export function containerState(name: string): string {
    return inspect(name, '{{.State.Status}}');
}

export function hasConfig(dir: string, exists: (path: string) => boolean = existsSync): boolean {
    return exists(join(dir, '.devcontainer', 'devcontainer.json')) || exists(join(dir, '.devcontainer.json'));
}

/** Resolve NAME to its workspace folder: the container's label, or else $SANDBOX_DIR/NAME. */
export function folderOf(
    name: string,
    { lookup = labelFolder, env = process.env }: { lookup?: (name: string) => string; env?: NodeJS.ProcessEnv } = {},
): string {
    checkName(name);
    const dir = lookup(name) || join(sandboxDir(env), name);
    if (!hasConfig(dir)) {
        throw new SandboxError(`no container or dev container config named '${name}' (looked in ${dir})`);
    }
    return dir;
}
