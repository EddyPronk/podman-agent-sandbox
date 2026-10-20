// sandbox export NAME: turn a sandbox made with --workspace into one that uses the project's own
// config (--inplace). Its config as it is now, with the user's edits, is written into the project as
// .devcontainer, without what sandbox added for this machine: those additions have fixed forms
// (workspace.js, seccomp.js), so they are recognised exactly, also in sandboxes made before 0.7.0.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SandboxError } from './devcontainer.js';
import { checkFields } from './inplace.js';
import { SECCOMP_RUN_ARG } from './seccomp.js';
import { MARKER } from './templates.js';
import { CONFIG_MOUNT, configFile, isInside, readConfig } from './workspace.js';

// The rule seccomp.js adds to the host's profile; older versions ended the comment differently.
const SECCOMP_RULE = 'sandbox: allowed for containers inside the sandbox';

/** Is MOUNT one that --workspace adds for WORKSPACE (git protection, --readonly, --hide)? */
export function addedMount(mount, workspace) {
    if (typeof mount !== 'string') return false;
    const parts = Object.fromEntries(mount.split(',').map((part) => part.split('=')));
    const target = parts.target;
    if (!target || !isInside(target, workspace) || target === workspace) return false;
    return mount === `type=bind,source=${target},target=${target},readonly`
        || mount === `type=tmpfs,target=${target},notmpcopyup`
        || mount === `type=bind,source=/dev/null,target=${target},readonly`;
}

/** The system calls sandbox added to the seccomp profile in CONFIG_DIR, or null if it didn't make it. */
export function generatedSeccomp(configDir) {
    const file = join(configDir, 'seccomp.json');
    if (!existsSync(file)) return null;
    try {
        const rule = JSON.parse(readFileSync(file, 'utf8')).syscalls?.find((r) => r.comment?.startsWith(SECCOMP_RULE));
        return rule ? rule.names : null;
    } catch {
        return null;
    }
}

/**
 * The config of the sandbox in DEST (made with --workspace SETTINGS.workspace) as it would be
 * committed: { config, skip, removed, leftovers }. CONFIG is the new devcontainer.json; SKIP the
 * files in .devcontainer not to write (a generated seccomp.json); REMOVED what was taken out, for
 * the user; LEFTOVERS lines that still name this machine's paths.
 */
export function exportedConfig(dest, settings, home = process.env.HOME) {
    const { workspace } = settings;
    const config = readConfig(configFile(dest));
    // What --inplace refuses (stageConfig, after the config is written), refused before anything is.
    checkFields(config, configFile(dest));
    const removed = [];
    const out = { ...config };
    // The workspace at its own path: back to the templates' /workspace, with the read-only mount of
    // the config itself (CONFIG_MOUNT), which --workspace dropped.
    if (config.workspaceMount === `source=${workspace},target=${workspace},type=bind`) {
        out.workspaceMount = 'source=${localWorkspaceFolder},target=/workspace,type=bind';
        out.workspaceFolder = '/workspace';
        removed.push(`the workspace at ${workspace} (back to /workspace)`);
    }
    const mounts = config.mounts ?? [];
    const kept = mounts.filter((m) => !addedMount(m, workspace));
    for (const m of mounts.filter((m) => addedMount(m, workspace))) removed.push(`mount ${m}`);
    out.mounts = kept.includes(CONFIG_MOUNT) ? kept : [...kept, CONFIG_MOUNT];
    // The seccomp profile sandbox generated from the host's, and the runArg that points at it: declared
    // as seccompAllow, not committed. sandbox adds both again when it makes the container.
    const skip = [];
    const names = generatedSeccomp(join(dest, '.devcontainer'));
    const marker = { version: 1, policies: [], ...(config.customizations?.[MARKER] ?? {}) };
    if (names) {
        skip.push('seccomp.json');
        removed.push('seccomp.json and its runArg (generated from this host\'s profile; declared as seccompAllow instead)');
        marker.seccompAllow ??= names;
        out.runArgs = (config.runArgs ?? []).filter((arg) => arg !== SECCOMP_RUN_ARG);
    }
    out.customizations = { ...(config.customizations ?? {}), [MARKER]: marker };
    const text = JSON.stringify(out, null, 2);
    const leftovers = text.split('\n').filter((line) => line.includes(workspace) || (home && line.includes(home)))
        .map((line) => line.trim());
    return { config: out, skip, removed, leftovers };
}

/** Refuse SETTINGS (from sandbox.json, or null) that can't be exported. */
export function checkExportable(name, dest, settings) {
    if (!settings) {
        throw new SandboxError(`${name} wasn't made with --workspace: there's no project to write its config into. `
            + `Copy ${join(dest, '.devcontainer')} into a project by hand, or make a sandbox there with `
            + '--workspace PATH --inplace --template TEMPLATE');
    }
    if (settings.inplace) {
        throw new SandboxError(`${name} already uses its project's config (${join(settings.workspace, '.devcontainer')})`);
    }
    if (existsSync(join(settings.workspace, '.devcontainer'))) {
        throw new SandboxError(`${join(settings.workspace, '.devcontainer')} already exists; export doesn't write over it`);
    }
}
