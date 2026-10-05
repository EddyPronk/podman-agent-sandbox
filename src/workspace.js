// Sandboxes around an existing folder (sandbox new --workspace): the project is mounted at its own
// path, its git repos' hooks and config are read-only, and the sandbox's config stays outside it.
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { SandboxError } from './devcontainer.js';

/** Where `sandbox new --workspace` records its choices, in the sandbox's config folder. */
export const SETTINGS = 'sandbox.json';

// git runs what these name (hooks, core.hooksPath, core.fsmonitor, aliases, ...) on the host.
const GIT_PARTS = ['hooks', 'config'];
// Folders full of other people's code, not the user's repos.
const SKIP = new Set(['node_modules', '.venv']);

/** Is PATH the folder ROOT or inside it? Both absolute and resolved. */
export function isInside(path, root) {
    const rel = relative(root, path);
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** Mount options are split on commas, so a path with one can't be mounted safely. */
function checkMountable(path) {
    if (/[,\n]/.test(path)) throw new SandboxError(`can't mount a path with a comma or newline: ${path}`);
    return path;
}

/** The project folder for --workspace: resolved against CWD, symlinks resolved, an existing directory. */
export function resolveWorkspace(path, cwd = process.cwd()) {
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
export function workspacePath(workspace, path, flag) {
    const abs = resolve(workspace, path);
    if (abs === workspace || !isInside(abs, workspace)) {
        throw new SandboxError(`--${flag} ${path}: not a path inside the workspace ${workspace}`);
    }
    let stat;
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
 * Every git directory under ROOT, as absolute paths: `.git` folders, not descending into them, nor
 * into node_modules, .venv or the HIDDEN paths (hidden ones aren't visible inside). A `.git` *file*
 * (a worktree or submodule) points at a git directory elsewhere, which this can't protect: refused.
 */
export function findGitDirs(root, hidden = []) {
    const found = [];
    const walk = (dir) => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
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

/** The read-only paths that protect GITDIRS: each one's hooks and config. */
export function gitProtectedPaths(gitDirs) {
    return gitDirs.flatMap((gitDir) => GIT_PARTS.map((part) => join(gitDir, part)));
}

/**
 * Mounts for a sandbox around WORKSPACE, as devcontainer.json "mounts" strings, outer paths first.
 * HIDE and READONLY are absolute paths inside the workspace (see workspacePath); CONFIG_DIR is the
 * sandbox's config folder, made read-only if it's inside the workspace.
 */
export function workspaceMounts({ workspace, hide = [], readonly = [], configDir, gitDirs }) {
    const mounts = [];
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
    const depth = (path) => path.split(sep).length;
    return mounts.sort((a, b) => depth(a.target) - depth(b.target) || a.target.localeCompare(b.target))
        .map((m) => m.spec);
}

/** The sandbox's devcontainer.json, which --workspace edits. */
export function configFile(configDir) {
    return join(configDir, '.devcontainer', 'devcontainer.json');
}

/** Parse a devcontainer.json; it must be plain JSON, since rewriting it would drop JSONC comments. */
export function readConfig(file) {
    const text = readFileSync(file, 'utf8');
    try {
        return JSON.parse(text);
    } catch {
        throw new SandboxError(`${file} isn't plain JSON (comments or trailing commas?); `
            + '--workspace rewrites it and would lose them, so remove them from the template first');
    }
}

/**
 * Turn the template's config in CONFIG_DIR into one around WORKSPACE: mount it at its own path as the
 * working folder, add MOUNTS after the template's own, and record the choices in sandbox.json.
 */
export function applyWorkspace(configDir, { workspace, hide, readonly, mounts }) {
    const file = configFile(configDir);
    if (!existsSync(file)) throw new SandboxError(`--workspace needs a template with .devcontainer/devcontainer.json`);
    const config = readConfig(file);
    config.workspaceMount = `source=${workspace},target=${workspace},type=bind`;
    config.workspaceFolder = workspace;
    config.mounts = [...(config.mounts ?? []), ...mounts];
    writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
    writeFileSync(join(configDir, SETTINGS), `${JSON.stringify({ workspace, hide, readonly }, null, 2)}\n`);
}

/** The recorded --workspace choices of the sandbox in CONFIG_DIR, or null if it has none. */
export function readSettings(configDir) {
    const file = join(configDir, SETTINGS);
    return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
}

/** Targets of the read-only mounts in a devcontainer.json "mounts" list (strings only). */
export function readonlyTargets(mounts = []) {
    return mounts.filter((m) => typeof m === 'string' && m.split(',').includes('readonly'))
        .map((m) => m.split(',').find((part) => part.startsWith('target='))?.slice('target='.length))
        .filter(Boolean);
}

/** The git paths under the workspace that READONLY (read-only mount targets) leaves writable. */
export function uncoveredGitPaths(gitDirs, readonly) {
    const covered = new Set(readonly);
    return gitProtectedPaths(gitDirs).filter((path) => !covered.has(path));
}

/**
 * For the sandbox whose config is in CONFIG_DIR: the git paths in its workspace that would be writable
 * inside. CONTAINER_READONLY is the container's read-only mount destinations if it exists (it keeps
 * the mounts it was created with), else null: then the config it would be created from counts.
 * [] for a sandbox not made with --workspace.
 */
export function uncoveredInSandbox(configDir, containerReadonly) {
    const settings = readSettings(configDir);
    if (!settings) return [];
    const gitDirs = findGitDirs(settings.workspace, hiddenPaths(settings));
    const readonly = containerReadonly ?? readonlyTargets(readConfig(configFile(configDir)).mounts);
    return uncoveredGitPaths(gitDirs, readonly);
}

/** NAME for `sandbox new --workspace PATH` without one: the folder's name. */
export function defaultName(workspace) {
    return basename(workspace);
}

/** The absolute paths given with --hide, from sandbox.json (stored relative to the workspace). */
export function hiddenPaths(settings) {
    return (settings.hide ?? []).map((path) => join(settings.workspace, path));
}

/** Resolve SANDBOX_DIR/NAME for the inside-the-workspace check, though it doesn't exist yet. */
export function realConfigDir(dest) {
    let existing = dest;
    const rest = [];
    while (!existsSync(existing)) {
        rest.unshift(basename(existing));
        existing = dirname(existing);
    }
    return join(realpathSync(existing), ...rest);
}
