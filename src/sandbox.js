// @ts-check
// A sandbox as the commands see it: its config folder and what podman has of it. The middle layer
// between the commands (cli.js) and the containers (container.js): the commands call one method of a
// Sandbox, and the Sandbox decides what that means for its containers and runs the checks first (the
// --inplace trust, the git protection, the config's version). The only layer that knows a sandbox may
// have more than one container.
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { Container } from './container.js';
import {
    SANDBOX_LABEL, SandboxError, checkName, childEnv, dc, exitStatus, hasConfig, podman, sandboxDir,
} from './devcontainer.js';
import { ask, configChange, short, writeEffective } from './inplace.js';
import { configVolumes, formatBytes, removedRows, table } from './inspect.js';
import { lockSandbox } from './lock.js';
import { checkMinVersion } from './templates.js';
import { configFile, readConfig, readSettings, uncoveredInSandbox } from './workspace.js';

/**
 * Sandbox NAME as it is now. With LOCK, take its lock first (sandbox enter, exec, stop and rm: the
 * commands that change it), so the state read is the one the command acts on.
 * @param {string} name
 * @param {{ lock?: boolean }} [options]
 */
export function loadSandbox(name, { lock = false } = {}) {
    checkName(name);
    const release = lock ? lockSandbox(name) : () => {};
    try {
        return new Sandbox(name, release);
    } catch (err) {
        release();
        throw err;
    }
}

export class Sandbox {
    /**
     * @param {string} name
     * @param {() => void} release  releases the lock, if taken
     */
    constructor(name, release) {
        this.name = name;
        this.release = release;
        /** @type {Container} */
        this.container = Container.load(name);
    }

    /** Read the state again, after a step that changed it. */
    reload() {
        this.container = Container.load(this.name);
    }

    /** The sandbox's config folder (folderOf): refuses when there's none. */
    get dir() {
        return this.container.dir;
    }

    /** Whether the sandbox has a container, running or not: one made from an older config or image. */
    made() {
        return this.container.exists;
    }

    /** sandbox enter: start it if needed, and open a shell; the shell's exit status. */
    enter() {
        try {
            this.#start();
        } finally {
            this.release();
        }
        return this.container.openShell();
    }

    /**
     * sandbox exec: start it if needed, and run COMMAND; its exit status.
     * @param {string[]} command
     */
    exec(command) {
        try {
            this.#start();
        } finally {
            this.release();
        }
        return this.container.exec(command);
    }

    /**
     * sandbox build: build the image, after the checks a container creation makes; the exit status.
     * @param {string[]} args  passed on to devcontainer build (--no-cache)
     */
    build(args) {
        const dir = this.dir;
        const inplace = checkTrusted(this.name, dir);
        if (inplace) writeEffective(dir, inplace);
        checkConfigVersion(dir);
        const result = dc('build', ['--workspace-folder', dir, ...args]);
        if (result.status !== 0) return exitStatus(result);
        if (this.made()) {
            console.error(`sandbox: ${this.name} still runs the old image; use 'sandbox rm ${this.name}' then 'sandbox enter ${this.name}'`);
        }
        return 0;
    }

    /**
     * sandbox stop; what to print. FORCE: also a container sandbox didn't make.
     * @param {{ force?: boolean }} [options]
     */
    stop({ force = false } = {}) {
        try {
            this.#checkOurs('stop', force);
            this.container.stop();
            return `stopped ${this.name}`;
        } finally {
            this.release();
        }
    }

    /**
     * sandbox rm: remove the container, keep its volumes and folders; what to print. FORCE as for stop.
     * @param {{ force?: boolean }} [options]
     */
    remove({ force = false } = {}) {
        try {
            this.#checkOurs('rm', force);
            let settings = null;
            try {
                settings = readSettings(this.dir);
            } catch {
                // no config folder left: nothing more to say
            }
            const volumes = this.container.volumes();
            this.container.remove();
            return [
                `removed ${this.name}`,
                ...volumes.map((volume) => `kept volume ${volume}, with what's in it (e.g. the home, podman's images `
                    + `inside): podman volume rm ${volume} removes it`),
                ...(settings ? [`${settings.workspace} is untouched: only the container was removed`] : []),
            ].join('\n');
        } finally {
            this.release();
        }
    }

    /** sandbox inspect: how it runs, or, without a container, what's left of it. */
    describe() {
        const { name, container } = this;
        if (!container.exists) {
            const folder = join(sandboxDir(), name);
            if (!hasConfig(folder)) throw new SandboxError(`no container '${name}', and no sandbox config in ${folder}`);
            // Removed with sandbox rm, or not created yet: what's left of it.
            return `# ${name} has no container (removed, or not created yet); sandbox enter ${name} creates it`
                + ` from its config.\n${table(removedSandbox(folder).rows)}`;
        }
        const { folder } = container;
        return container.describe({ untrusted: folder ? untrustedChange(folder) : null });
    }

    /**
     * Make the container running, after the checks: an --inplace sandbox's project config must be the
     * one trusted (and the config that runs is made again before creating the container: a newer
     * sandbox's settings apply without a new trust), the config's minVersion, and the git protection
     * of a --workspace sandbox, against the mounts of the container when it exists.
     */
    #start() {
        const { name, container } = this;
        const dir = this.dir;
        const inplace = checkTrusted(name, dir);
        if (inplace && !container.exists) writeEffective(dir, inplace);
        if (!container.exists) checkConfigVersion(dir);
        checkWorkspace(name, dir, container.exists ? container.readonlyMounts() : null);
        container.start();
        this.reload();
    }

    /**
     * Refuse to SUB (stop, rm) a container without the sandbox label, unless FORCE.
     * @param {string} sub
     * @param {boolean} force
     */
    #checkOurs(sub, force) {
        const { name, container } = this;
        if (force || !container.exists) return;
        const found = container.sandbox;
        if (found.reason) return;
        const why = found.hint
            ? `${found.hint[0].toUpperCase()}${found.hint.slice(1)}, so it may be a sandbox made before 0.6.0, `
                + 'or a container another tool (VS Code) made there.'
            : 'It may be VS Code\'s or your own.';
        throw new SandboxError(`${name} isn't a sandbox: it has no ${SANDBOX_LABEL} label. ${why}\n`
            + `Check it with sandbox inspect ${name}. To ${sub} it anyway: sandbox ${sub} --force ${name} `
            + `(or podman ${sub} ${name}).`
            + (found.hint ? ' A sandbox made before 0.6.0 gets the label when made again with sandbox new.' : ''));
    }
}

/** sandbox list: the dev containers, as a table. */
export function listSandboxes() {
    const result = podman(['ps', '-a', '--filter', 'label=devcontainer.local_folder', '--format',
        '{{.Names}}\t{{.State}}\t{{.Networks}}\t{{.Label "devcontainer.local_folder"}}']);
    if (result.status !== 0) throw new SandboxError(result.stderr.trim());
    return table([['NAME', 'STATE', 'NETWORK', 'FOLDER'],
        ...result.stdout.split('\n').filter(Boolean).map((line) => line.split('\t'))]);
}

/**
 * sandbox list --removed: config folders in $SANDBOX_DIR that no container uses (removed with
 * sandbox rm, or never entered), with the volumes they keep. Sandboxes whose config folder is
 * elsewhere can't be found once their container is gone.
 */
export function listRemoved() {
    const result = podman(['ps', '-a', '--format', '{{.Label "devcontainer.local_folder"}}']);
    if (result.status !== 0) throw new SandboxError(result.stderr.trim());
    const used = new Set(result.stdout.split('\n').filter(Boolean));
    const dir = sandboxDir();
    const folders = existsSync(dir) ? readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isDirectory() && hasConfig(join(dir, e.name)) && !used.has(join(dir, e.name)))
        .map((e) => join(dir, e.name)).sort() : [];
    const rows = [['NAME', 'WORKSPACE', 'KEPT VOLUMES']];
    for (const folder of folders) {
        const { settings, volumes } = removedSandbox(folder);
        const kept = volumes.filter((v) => v.bytes !== null).map((v) => `${v.name} (${formatBytes(v.bytes)})`);
        rows.push([basename(folder), settings?.workspace ?? folder, kept.join(', ') || 'none']);
    }
    return rows.length > 1 ? table(rows) : `no removed sandboxes in ${dir}`;
}

/**
 * What's left of the sandbox in config folder FOLDER without its container: { settings, volumes, rows }.
 * @param {string} folder
 */
function removedSandbox(folder) {
    let settings = null;
    /** @type {{ name: string, bytes: number | null }[]} */
    let volumes = [];
    try {
        settings = readSettings(folder);
        volumes = configVolumes(readConfig(configFile(folder)), folder, childEnv())
            .map((/** @type {string} */ name) => ({ name, bytes: volumeBytes(name) }));
    } catch {
        // an unreadable sandbox.json or config: show what there is
    }
    const untrusted = settings?.inplace ? untrustedChange(folder) : null;
    return { settings, volumes, rows: removedRows(folder, settings, untrusted, volumes) };
}

/**
 * Bytes on disk in volume NAME, or null when it doesn't exist. `podman unshare du`: in a sandbox's
 * home volume, files of containers inside are owned by subordinate IDs that a plain du can't read.
 * @param {string} name
 */
function volumeBytes(name) {
    const mountpoint = podman(['volume', 'inspect', '--format', '{{.Mountpoint}}', name]);
    if (mountpoint.status !== 0) return null;
    const du = podman(['unshare', 'du', '-sk', mountpoint.stdout.trim()]);
    const kb = Number(du.stdout.split('\t')[0]);
    return Number.isFinite(kb) && du.stdout ? kb * 1024 : 0;
}

/**
 * Before creating NAME's container or image from the config in DIR: refuse when its marker asks for
 * a newer sandbox (minVersion), e.g. after installing an older release. A container that exists was
 * made already, and keeps running.
 * @param {string} dir
 */
function checkConfigVersion(dir) {
    const file = configFile(dir);
    if (!existsSync(file)) return;
    let config = null;
    try {
        config = JSON.parse(readFileSync(file, 'utf8'));
    } catch {
        return;   // not plain JSON: the Dev Containers CLI reads it (JSONC) and has the last word
    }
    checkMinVersion(config, file);
}

/**
 * For a sandbox made with --workspace: refuse to start if a git repo in the workspace would have
 * writable hooks or config inside. Repos get added or moved after the sandbox was made. A container
 * keeps the mounts it was created with, so check those (READONLY, its read-only mounts) when it
 * exists, else (null) the config.
 * @param {string} name
 * @param {string} dir
 * @param {string[] | null} readonly
 */
function checkWorkspace(name, dir, readonly) {
    const settings = readSettings(dir);
    if (!settings) return;
    const missing = uncoveredInSandbox(dir, readonly);
    if (missing.length === 0) return;
    const redo = readonly ? `sandbox rm ${name}; ` : '';
    throw new SandboxError(`these would be writable inside ${name}, and git on the host runs what they name:\n`
        + missing.map((/** @type {string} */ path) => `  ${path}\n`).join('')
        + `Make the sandbox again (the options are in ${join(dir, 'sandbox.json')}):\n`
        + `  ${redo}rm -r ${dir}; sandbox new ${name} --template ... --workspace ${settings.workspace} ...`);
}

/**
 * For an --inplace sandbox (in DIR): refuse when the project's config isn't the one the user trusted,
 * offering the diff. Returns its settings, or null for other sandboxes.
 * @param {string} name
 * @param {string} dir
 */
function checkTrusted(name, dir) {
    const settings = readSettings(dir);
    if (!settings?.inplace) return null;
    const change = configChange(dir, settings);
    if (!change) return settings;
    const config = join(settings.workspace, '.devcontainer');
    if (!change.now) {
        throw new SandboxError(`${name}: ${config} is gone (trusted: ${short(change.trusted)}); restore it, `
            + `or remove the sandbox (sandbox rm ${name}, then rm -r ${dir})`);
    }
    console.error(`sandbox: ${name}: the project's config changed since you trusted it (${short(change.trusted)} -> ${short(change.now)}).`);
    const command = change.diff.join(' ');
    const show = ask(`Show what changed (${command})? [Y/n] `);
    if (show === null) {
        console.error(`See what changed:  ${command}`);
    } else if (!['n', 'no'].includes(show)) {
        spawnSync(change.diff[0], change.diff.slice(1), { stdio: 'inherit' });
    }
    throw new SandboxError(`not using ${name} until you decide: 'sandbox trust ${name}' to review and use the new `
        + `config, or restore ${config}`);
}

/**
 * For an --inplace sandbox in FOLDER: how its project's config differs from the trusted one, or null.
 * @param {string} folder
 */
function untrustedChange(folder) {
    let settings;
    try {
        settings = readSettings(folder);
    } catch {
        return null;
    }
    if (!settings?.inplace) return null;
    const change = configChange(folder, settings);
    if (!change) return null;
    const config = join(settings.workspace, '.devcontainer');
    return change.now
        ? `the project's config changed since it was trusted (${short(change.trusted)} -> ${short(change.now)}; ${change.diff.join(' ')})`
        : `the project's config ${config} is gone`;
}
