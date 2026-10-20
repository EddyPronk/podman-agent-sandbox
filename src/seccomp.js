// A seccomp profile for templates that run containers inside the sandbox (claude-containers):
// the host podman's own default profile, plus a few calls the config names in its devcontainer.json
// ("customizations": { "podman-agent-sandbox": { "seccompAllow": [...] } }, or in older templates'
// metadata "x-sandbox"), written to the sandbox's .devcontainer/seccomp.json. Generated at
// `sandbox new` (and for --inplace sandboxes at every container creation) so it matches the user's
// podman; the template ships a copy of podman's default as the fallback for hosts whose podman has no
// profile file.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SandboxError } from './devcontainer.js';

/**
 * The runArg that points podman at that profile. Like the profile, it belongs to the config that
 * runs, not to one committed in a project (--inplace, export): there the file doesn't exist, and
 * the Dev Containers CLI on its own would fail to start the container.
 */
export const SECCOMP_RUN_ARG = '--security-opt=seccomp=${localWorkspaceFolder}/.devcontainer/seccomp.json';

/**
 * PROFILE with NAMES allowed without conditions: removed from every other rule (podman's default
 * allows sethostname only with CAP_SYS_ADMIN), then allowed in a rule of their own. Returns a copy.
 */
export function allowSyscalls(profile, names) {
    const out = structuredClone(profile);
    out.syscalls = out.syscalls
        .map((rule) => ({ ...rule, names: rule.names.filter((n) => !names.includes(n)) }))
        .filter((rule) => rule.names.length);
    out.syscalls.push({
        names: [...names],
        action: 'SCMP_ACT_ALLOW',
        comment: 'sandbox: allowed for containers inside the sandbox (seccompAllow)',
    });
    return out;
}

/** Whether VALUE (parsed JSON) has what allowSyscalls needs: syscalls, each with a list of names. */
function isProfile(value) {
    return typeof value === 'object' && value !== null && Array.isArray(value.syscalls)
        && value.syscalls.every((rule) => typeof rule === 'object' && rule !== null && Array.isArray(rule.names)
            && rule.names.every((n) => typeof n === 'string'));
}

/** The host podman's default seccomp profile (it follows containers.conf), or null if it has no file. */
export function hostSeccompProfile() {
    const result = spawnSync('podman', ['info', '--format', '{{.Host.Security.SECCOMPProfilePath}}'],
        { encoding: 'utf8' });
    const path = result.status === 0 ? result.stdout.trim() : '';
    return path && existsSync(path) ? path : null;
}

/**
 * Write DEST/.devcontainer/seccomp.json: the host's default profile (or else the one the template
 * shipped there) with NAMES allowed. OPTIONS: seccompSource() → path or null, log(message).
 */
export function writeSeccompProfile(dest, names, { seccompSource = hostSeccompProfile, log = console.error } = {}) {
    const out = join(dest, '.devcontainer', 'seccomp.json');
    let source = seccompSource();
    if (!source) {
        if (!existsSync(out)) {
            throw new SandboxError('no seccomp profile: podman reports no default profile file, and the template ships none');
        }
        log('sandbox: warning: podman reports no default seccomp profile file; using the one shipped with '
            + 'the template, which may not match your podman version');
        source = out;
    }
    let profile;
    try {
        profile = JSON.parse(readFileSync(source, 'utf8'));
    } catch (err) {
        throw new SandboxError(`cannot read the seccomp profile ${source}: ${err.message}`);
    }
    if (!isProfile(profile)) throw new SandboxError(`${source} is not a seccomp profile (no list of syscalls with names)`);
    writeFileSync(out, JSON.stringify(allowSyscalls(profile, names), null, 2) + '\n');
    log(`sandbox: seccomp profile from ${source}, with ${names.join(', ')} allowed`);
}
