// A seccomp profile for templates that run containers inside the sandbox (claude-containers):
// the host podman's own default profile, plus a few calls the template names in its metadata
// ("x-sandbox": { "seccompAllow": [...] }), written to the new sandbox's .devcontainer/seccomp.json.
// Generated at `sandbox new` so it matches the user's podman; the template ships a copy of podman's
// default as the fallback for hosts whose podman has no profile file.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SandboxError } from './devcontainer.js';

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
        comment: 'sandbox: allowed for containers inside the sandbox (template x-sandbox.seccompAllow)',
    });
    return out;
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
    writeFileSync(out, JSON.stringify(allowSyscalls(profile, names), null, 2) + '\n');
    log(`sandbox: seccomp profile from ${source}, with ${names.join(', ')} allowed`);
}
