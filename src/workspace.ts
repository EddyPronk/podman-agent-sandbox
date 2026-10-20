// Sandboxes around an existing folder (sandbox new --workspace): the project is mounted at its own
// path, its git repos' hooks and config are read-only, and the sandbox's config stays outside it.
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import type { Dirent, Stats } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { SandboxError } from './devcontainer.js';

/** Where `sandbox new --workspace` records its choices, in the sandbox's config folder. */
export const SETTINGS = 'sandbox.json';

/** A devcontainer.json, as far as readConfig checks it; its other fields are kept as they are. */
export interface DevcontainerConfig {
    mounts?: unknown[];
    [field: string]: unknown;
}

/**
 * sandbox.json: what `sandbox new --workspace` chose. HIDE and READONLY are relative to the
 * workspace; INPLACE and CONFIG_TREE are there for --inplace (the trusted project config's id).
 */
export interface Settings {
    workspace: string;
    hide?: string[];
    readonly?: string[];
    inplace?: boolean;
    configTree?: string;
}

// git runs what these name (hooks, core.hooksPath, core.fsmonitor, aliases, ...) on the host.
const GIT_PARTS = ['hooks', 'config'];
// Folders full of other people's code, not the user's repos.
const SKIP = new Set(['node_modules', '.venv']);

/** Is PATH the folder ROOT or inside it? Both absolute and resolved. */
export function isInside(path: string, root: string): boolean {
    const rel = relative(root, path);
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** Mount options are split on commas, so a path with one can't be mounted safely. */
function checkMountable(path: string): string {
    if (/[,\n]/.test(path)) throw new SandboxError(`can't mount a path with a comma or newline: ${path}`);
    return path;
}

/** The project folder for --workspace: resolved against CWD, symlinks resolved, an existing directory. */
export function resolveWorkspace(path: string, cwd: string = process.cwd()): string {
    const abs = resolve(cwd, path);
    if (!existsSync(abs)) throw new SandboxError(`workspace ${abs} does not exist`);
    const real = realpathSync(abs);
    if (!statSync(real).isDirectory()) throw new SandboxError(`workspace ${real} is not a directory`);
    if (real === '/') throw new SandboxError('the workspace can\'t be /');
    return checkMountable(real);
}

/**
 * A --hide or --readonly PATH, relative to the workspace: its absolute path, which must exist, stay
 * inside the workspace, and not be a symlink (a mount would follow it, maybe out of the workspace).
 */
export function workspacePath(workspace: string, path: string, flag: string): string {
    const abs = resolve(workspace, path);
    if (abs === workspace || !isInside(abs, workspace)) {
        throw new SandboxError(`--${flag} ${path}: not a path inside the workspace ${workspace}`);
    }
    let stat: Stats;
    try {
        stat = lstatSync(abs);
    } catch {
        throw new SandboxError(`--${flag} ${path}: ${abs} does not exist`);
    }
    if (stat.isSymbolicLink()) throw new SandboxError(`--${flag} ${path}: ${abs} is a symlink; give the path it points to`);
    if (realpathSync(abs) !== abs) throw new SandboxError(`--${flag} ${path}: ${abs} is under a symlink; give the real path`);
    return checkMountable(abs);
}

/**
 * DIR's entries, or none when it can't be read. The sandbox runs as the user, so what they can't
 * read, the agent can't read either (e.g. a database's data folder owned by another user).
 */
function entries(dir: string): Dirent[] {
    try {
        return readdirSync(dir, { withFileTypes: true });
    } catch (err) {
        if (err instanceof Error && 'code' in err && (err.code === 'EACCES' || err.code === 'EPERM')) return [];
        throw err;
    }
}

/**
 * Every git directory under ROOT, as absolute paths: `.git` folders, not descending into them, nor
 * into node_modules, .venv or the HIDDEN paths (hidden ones aren't visible inside). A `.git` *file*
 * (a worktree or submodule) points at a git directory elsewhere, which this can't protect: refused.
 */
export function findGitDirs(root: string, hidden: string[] = []): string[] {
    const found: string[] = [];
    const walk = (dir: string) => {
        for (const entry of entries(dir)) {
            const path = join(dir, entry.name);
            if (hidden.includes(path)) continue;
            if (entry.name === '.git') {
                if (entry.isDirectory()) {
                    found.push(path);
                } else {
                    throw new SandboxError(`${path} is a file (a git worktree or submodule): its git directory `
                        + 'is elsewhere and would stay writable, so --workspace refuses it for now');
                }
            } else if (entry.isDirectory() && !SKIP.has(entry.name)) {
                walk(path);   // symlinks aren't followed: isDirectory() is false for them
            }
        }
    };
    walk(root);
    return found.sort();
}

// Names of files that often hold secrets: .env files, private keys and key stores, SSH keys,
// .netrc, (.)credentials.json (Claude Code's sign-in, Google's OAuth clients). Examples of .env
// files don't. Only a hint for a warning: anything can hold a secret.
const SECRET_NAME = /^(\.env(\..+)?|.+\.(pem|key|p12|pfx)|id_(rsa|dsa|ecdsa|ed25519)|\.netrc|\.?credentials\.json)$/;
const NOT_SECRET = /^\.env\.(example|sample|template|dist)$/;

/**
 * Files in ROOT whose names suggest secrets, relative to ROOT and sorted: not in HIDDEN (absolute
 * paths; a folder covers what's in it), .git, node_modules or .venv.
 */
export function findSecretFiles(root: string, hidden: string[] = []): string[] {
    const found: string[] = [];
    const walk = (dir: string) => {
        for (const entry of entries(dir)) {
            const path = join(dir, entry.name);
            if (hidden.includes(path)) continue;
            if (entry.isDirectory()) {
                if (entry.name !== '.git' && !SKIP.has(entry.name)) walk(path);
            } else if (entry.isFile() && SECRET_NAME.test(entry.name) && !NOT_SECRET.test(entry.name)) {
                found.push(relative(root, path));
            }
        }
    };
    walk(root);
    return found.sort();
}

/** The read-only paths that protect GITDIRS: each one's hooks and config. */
export function gitProtectedPaths(gitDirs: string[]): string[] {
    return gitDirs.flatMap((gitDir) => GIT_PARTS.map((part) => join(gitDir, part)));
}

/**
 * Mounts for a sandbox around WORKSPACE, as devcontainer.json "mounts" strings, outer paths first.
 * HIDE and READONLY are absolute paths inside the workspace (see workspacePath); CONFIG_DIR is the
 * sandbox's config folder, made read-only if it's inside the workspace.
 */
export function workspaceMounts({ workspace, hide = [], readonly = [], configDir, gitDirs }: {
    workspace: string;
    hide?: string[];
    readonly?: string[];
    configDir?: string;
    gitDirs: string[];
}): string[] {
    const mounts: { target: string; spec: string }[] = [];
    for (const path of gitProtectedPaths(gitDirs)) {
        if (!existsSync(path)) {
            throw new SandboxError(`${path} is missing, so it can't be made read-only and the agent could create it; `
                + `create it first (e.g. mkdir ${path}) and try again`);
        }
        mounts.push({ target: path, spec: `type=bind,source=${path},target=${path},readonly` });
    }
    for (const path of readonly) {
        mounts.push({ target: path, spec: `type=bind,source=${path},target=${path},readonly` });
    }
    if (configDir && isInside(configDir, workspace)) {
        checkMountable(configDir);
        mounts.push({ target: configDir, spec: `type=bind,source=${configDir},target=${configDir},readonly` });
    }
    for (const path of hide) {
        // Without notmpcopyup, Podman copies what's under the target into the tmpfs.
        mounts.push({ target: path, spec: statSync(path).isDirectory()
            ? `type=tmpfs,target=${path},notmpcopyup`
            : `type=bind,source=/dev/null,target=${path},readonly` });
    }
    // Parents before children, so that a mount inside another (--hide in a --readonly folder) wins.
    const depth = (path: string) => path.split(sep).length;
    return mounts.sort((a, b) => depth(a.target) - depth(b.target) || a.target.localeCompare(b.target))
        .map((m) => m.spec);
}

/**
 * The bundled templates mount the sandbox's own config read-only over the workspace: without it, the
 * agent could edit .devcontainer/ in /workspace, and the next container creation would use it (an
 * initializeCommand even runs on the host). --workspace drops it: there the config is outside the
 * project, or mounted read-only where it is (workspaceMounts).
 */
export const CONFIG_MOUNT = 'type=bind,source=${localWorkspaceFolder}/.devcontainer,target=/workspace/.devcontainer,readonly';

/** The sandbox's devcontainer.json, which --workspace edits. */
export function configFile(configDir: string): string {
    return join(configDir, '.devcontainer', 'devcontainer.json');
}

/** Parse a devcontainer.json; it must be plain JSON, since rewriting it would drop JSONC comments. */
export function readConfig(file: string): DevcontainerConfig {
    const text = readFileSync(file, 'utf8');
    let config: unknown;
    try {
        config = JSON.parse(text);
    } catch {
        throw new SandboxError(`${file} isn't plain JSON (comments or trailing commas?); `
            + 'sandbox rewrites it and would lose them, so remove them first');
    }
    if (!isConfig(config)) {
        throw new SandboxError(`${file} isn't a devcontainer.json: not an object, or its "mounts" isn't a list`);
    }
    return config;
}

/** A JSON object: not null, not a list. */
function isObject(value: unknown): value is { [field: string]: unknown } {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isConfig(value: unknown): value is DevcontainerConfig {
    return isObject(value) && (value.mounts === undefined || Array.isArray(value.mounts));
}

/**
 * Turn the template's config in CONFIG_DIR into one around WORKSPACE: mount it at its own path as the
 * working folder, add MOUNTS after the template's own, and record the choices in sandbox.json.
 */
export function applyWorkspace(configDir: string, { workspace, hide, readonly, mounts }: {
    workspace: string;
    hide?: string[];
    readonly?: string[];
    mounts: string[];
}): void {
    const file = configFile(configDir);
    if (!existsSync(file)) throw new SandboxError(`--workspace needs a template with .devcontainer/devcontainer.json`);
    writeFileSync(file, `${JSON.stringify(aroundWorkspace(readConfig(file), workspace, mounts), null, 2)}\n`);
    writeSettings(configDir, { workspace, hide, readonly });
}

/** CONFIG turned into one around WORKSPACE, with MOUNTS after its own (its CONFIG_MOUNT dropped). */
export function aroundWorkspace(config: DevcontainerConfig, workspace: string, mounts: string[]): DevcontainerConfig {
    return {
        ...config,
        workspaceMount: `source=${workspace},target=${workspace},type=bind`,
        workspaceFolder: workspace,
        mounts: [...(config.mounts ?? []).filter((m) => m !== CONFIG_MOUNT), ...mounts],
    };
}

/** Write SETTINGS to CONFIG_DIR/sandbox.json. */
export function writeSettings(configDir: string, settings: Settings): void {
    writeFileSync(join(configDir, SETTINGS), `${JSON.stringify(settings, null, 2)}\n`);
}

/** The recorded --workspace choices of the sandbox in CONFIG_DIR, or null if it has none. */
export function readSettings(configDir: string): Settings | null {
    const file = join(configDir, SETTINGS);
    if (!existsSync(file)) return null;
    const settings: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (!isSettings(settings)) {
        throw new SandboxError(`${file} isn't a sandbox.json: it needs a "workspace", and "hide", "readonly", `
            + '"inplace" and "configTree" (if there) as sandbox new writes them');
    }
    return settings;
}

function isSettings(value: unknown): value is Settings {
    const paths = (v: unknown) => v === undefined || (Array.isArray(v) && v.every((p) => typeof p === 'string'));
    return isObject(value) && typeof value.workspace === 'string' && paths(value.hide) && paths(value.readonly)
        && (value.inplace === undefined || typeof value.inplace === 'boolean')
        && (value.configTree === undefined || typeof value.configTree === 'string');
}

/** Targets of the read-only mounts in a devcontainer.json "mounts" list (strings only). */
export function readonlyTargets(mounts: unknown[] = []): string[] {
    return mounts.filter((m): m is string => typeof m === 'string' && m.split(',').includes('readonly'))
        .map((m) => m.split(',').find((part) => part.startsWith('target='))?.slice('target='.length))
        .filter((target): target is string => Boolean(target));
}

/** The git paths under the workspace that READONLY (read-only mount targets) leaves writable. */
export function uncoveredGitPaths(gitDirs: string[], readonly: string[]): string[] {
    const covered = new Set(readonly);
    return gitProtectedPaths(gitDirs).filter((path) => !covered.has(path));
}

/**
 * For the sandbox whose config is in CONFIG_DIR: the git paths in its workspace that would be writable
 * inside. CONTAINER_READONLY is the container's read-only mount destinations if it exists (it keeps
 * the mounts it was created with), else null: then the config it would be created from counts.
 * [] for a sandbox not made with --workspace.
 */
export function uncoveredInSandbox(configDir: string, containerReadonly: string[] | null): string[] {
    const settings = readSettings(configDir);
    if (!settings) return [];
    const gitDirs = findGitDirs(settings.workspace, hiddenPaths(settings));
    const readonly = containerReadonly ?? readonlyTargets(readConfig(configFile(configDir)).mounts);
    return uncoveredGitPaths(gitDirs, readonly);
}

/** NAME for `sandbox new --workspace PATH` without one: the folder's name. */
export function defaultName(workspace: string): string {
    return basename(workspace);
}

/** The absolute paths given with --hide, from sandbox.json (stored relative to the workspace). */
export function hiddenPaths(settings: Settings): string[] {
    return (settings.hide ?? []).map((path) => join(settings.workspace, path));
}

/** Resolve SANDBOX_DIR/NAME for the inside-the-workspace check, though it doesn't exist yet. */
export function realConfigDir(dest: string): string {
    let existing = dest;
    const rest: string[] = [];
    while (!existsSync(existing)) {
        rest.unshift(basename(existing));
        existing = dirname(existing);
    }
    return join(realpathSync(existing), ...rest);
}
