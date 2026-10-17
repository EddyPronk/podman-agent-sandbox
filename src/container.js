// Starting a sandbox's container, and the checks before it: the config's version, an --inplace
// sandbox's trust, the git protection of a --workspace sandbox.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SandboxError, containerState, dc, podman } from './devcontainer.js';
import { ask, configChange, short, writeEffective } from './inplace.js';
import { checkMinVersion } from './templates.js';
import { configFile, readSettings, uncoveredInSandbox } from './workspace.js';

/**
 * Before creating NAME's container or image from the config in DIR: refuse when its marker asks for
 * a newer sandbox (minVersion), e.g. after installing an older release. A container that exists was
 * made already, and keeps running.
 */
export function checkConfigVersion(dir) {
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

/** Start NAME if it isn't running: create its container (building the image) or restart it. */
export function ensureRunning(name, dir) {
    const state = containerState(name);
    // An --inplace sandbox: refuse an untrusted project config, and make the config that runs again
    // before creating the container (a newer sandbox's settings apply without a new trust).
    const inplace = checkTrusted(name, dir);
    if (inplace && !state) writeEffective(dir, inplace);
    if (!state) checkConfigVersion(dir);
    checkWorkspace(name, dir, state);
    if (state !== 'running') {
        // up creates the container, or starts it if it exists but is stopped.
        // Creating it may build the image first, which takes minutes: show that log
        // (on stderr). Restarting is quick, and its log only matters when it fails.
        const create = !state;
        console.error(`sandbox: ${create ? 'creating' : 'starting'} ${name} ...`);
        const up = dc('up', ['--workspace-folder', dir], create
            ? { stdio: ['ignore', 2, 2] }
            : { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
        if (up.status !== 0) {
            if (!create) process.stderr.write(up.stdout + up.stderr);
            throw new SandboxError(`failed to start '${name}'`);
        }
    }
}

/**
 * For a sandbox made with --workspace: refuse to start if a git repo in the workspace would have
 * writable hooks or config inside. Repos get added or moved after the sandbox was made. The
 * container keeps the mounts it was created with, so check those when it exists, else the config.
 */
export function checkWorkspace(name, dir, state) {
    const settings = readSettings(dir);
    if (!settings) return;
    const missing = uncoveredInSandbox(dir, state ? containerReadonlyMounts(name) : null);
    if (missing.length === 0) return;
    const redo = state ? `sandbox rm ${name}; ` : '';
    throw new SandboxError(`these would be writable inside ${name}, and git on the host runs what they name:\n`
        + missing.map((path) => `  ${path}\n`).join('')
        + `Make the sandbox again (the options are in ${join(dir, 'sandbox.json')}):\n`
        + `  ${redo}rm -r ${dir}; sandbox new ${name} --template ... --workspace ${settings.workspace} ...`);
}

/**
 * For an --inplace sandbox (in DIR): refuse when the project's config isn't the one the user trusted,
 * offering the diff. Returns its settings, or null for other sandboxes.
 */
export function checkTrusted(name, dir) {
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

/** Destinations of container NAME's read-only mounts. */
export function containerReadonlyMounts(name) {
    const result = podman(['container', 'inspect', '--format',
        '{{range .Mounts}}{{if not .RW}}{{.Destination}}{{"\\n"}}{{end}}{{end}}', name]);
    if (result.status !== 0) throw new SandboxError(result.stderr.trim());
    return result.stdout.split('\n').filter(Boolean);
}
