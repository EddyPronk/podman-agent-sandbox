// sandbox export NAME: turn a sandbox made with --workspace into one that uses the project's own
// config (--inplace). Its config as it is now, with the user's edits, is written into the project as
// .devcontainer, without what sandbox added for this machine: those additions have fixed forms
// (workspace.ts, seccomp.ts), so they are recognised exactly, also in sandboxes made before 0.7.0.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SandboxError } from './devcontainer.js';
import { checkFields } from './inplace.js';
import type { ProjectConfig } from './inplace.js';
import { isObject, isStringList } from './json.js';
import type { JsonObject } from './json.js';
import { SECCOMP_RUN_ARG } from './seccomp.js';
import { MARKER, markerOf } from './templates.js';
import { CONFIG_MOUNT, configFile, isInside, readConfig } from './workspace.js';
import type { Settings } from './workspace.js';

// The rule seccomp.ts adds to the host's profile; older versions ended the comment differently.
const SECCOMP_RULE = 'sandbox: allowed for containers inside the sandbox';

/** exportedConfig's result: see there. */
export interface ExportedConfig {
    config: ProjectConfig;
    skip: string[];
    removed: string[];
    leftovers: string[];
}

/** Is MOUNT one that --workspace adds for WORKSPACE (git protection, --readonly, --hide)? */
export function addedMount(mount: unknown, workspace: string): boolean {
    if (typeof mount !== 'string') return false;
    const target = mount.split(',').map((part) => part.split('=')).find(([key]) => key === 'target')?.[1];
    if (!target || !isInside(target, workspace) || target === workspace) return false;
    return mount === `type=bind,source=${target},target=${target},readonly`
        || mount === `type=tmpfs,target=${target},notmpcopyup`
        || mount === `type=bind,source=/dev/null,target=${target},readonly`;
}

/** The system calls sandbox added to the seccomp profile in CONFIG_DIR, or null if it didn't make it. */
export function generatedSeccomp(configDir: string): string[] | null {
    const file = join(configDir, 'seccomp.json');
    if (!existsSync(file)) return null;
    let profile: unknown;
    try {
        profile = JSON.parse(readFileSync(file, 'utf8'));
    } catch {
        return null;
    }
    const rules: unknown[] = isObject(profile) && Array.isArray(profile.syscalls) ? profile.syscalls : [];
    for (const rule of rules) {
        if (isObject(rule) && typeof rule.comment === 'string' && rule.comment.startsWith(SECCOMP_RULE)) {
            return isStringList(rule.names) ? rule.names : null;
        }
    }
    return null;
}

/**
 * The config of the sandbox in DEST (made with --workspace SETTINGS.workspace) as it would be
 * committed: { config, skip, removed, leftovers }. CONFIG is the new devcontainer.json; SKIP the
 * files in .devcontainer not to write (a generated seccomp.json); REMOVED what was taken out, for
 * the user; LEFTOVERS lines that still name this machine's paths.
 */
export function exportedConfig(dest: string, settings: Settings, home: string | undefined = process.env.HOME): ExportedConfig {
    const { workspace } = settings;
    const config = readConfig(configFile(dest));
    // What --inplace refuses (stageConfig, after the config is written), refused before anything is.
    checkFields(config, configFile(dest));
    const removed: string[] = [];
    const out: ProjectConfig = { ...config };
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
    const skip: string[] = [];
    const names = generatedSeccomp(join(dest, '.devcontainer'));
    const marker: JsonObject = { version: 1, policies: [], ...markerOf(config) };
    if (names) {
        skip.push('seccomp.json');
        removed.push('seccomp.json and its runArg (generated from this host\'s profile; declared as seccompAllow instead)');
        marker.seccompAllow ??= names;
        out.runArgs = (config.runArgs ?? []).filter((arg) => arg !== SECCOMP_RUN_ARG);
    }
    out.customizations = { ...(isObject(config.customizations) ? config.customizations : {}), [MARKER]: marker };
    const text = JSON.stringify(out, null, 2);
    const leftovers = text.split('\n').filter((line) => line.includes(workspace) || (home && line.includes(home)))
        .map((line) => line.trim());
    return { config: out, skip, removed, leftovers };
}

/** Refuse SETTINGS (from sandbox.json, or null) that can't be exported. */
export function checkExportable(name: string, dest: string, settings: Settings | null): asserts settings is Settings {
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
