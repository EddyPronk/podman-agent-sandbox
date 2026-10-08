import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { allowSyscalls, writeSeccompProfile } from '../src/seccomp.js';
import { applyTemplate } from '../src/templates.js';

/** A small profile shaped like podman's default: sethostname is allowed only with CAP_SYS_ADMIN. */
function fixture() {
    return {
        defaultAction: 'SCMP_ACT_ERRNO',
        syscalls: [
            { names: ['read', 'write'], action: 'SCMP_ACT_ALLOW' },
            { names: ['sethostname', 'setdomainname'], action: 'SCMP_ACT_ALLOW',
                includes: { caps: ['CAP_SYS_ADMIN'] } },
            { names: ['mount', 'sethostname'], action: 'SCMP_ACT_ALLOW', includes: { caps: ['CAP_SYS_ADMIN'] } },
        ],
    };
}

/** Every syscall name a profile allows without conditions. */
function allowedOutright(profile) {
    return profile.syscalls.filter((r) => r.action === 'SCMP_ACT_ALLOW' && !r.includes && !r.args)
        .flatMap((r) => r.names).sort();
}

test('allowSyscalls allows exactly the given calls more, without conditions', () => {
    const source = fixture();
    const out = allowSyscalls(source, ['sethostname', 'setdomainname']);
    assert.deepEqual(allowedOutright(out), ['read', 'setdomainname', 'sethostname', 'write']);
    assert.equal(out.defaultAction, 'SCMP_ACT_ERRNO', 'the rest is unchanged');
    assert.deepEqual(out.syscalls.find((r) => r.names.includes('mount')).names, ['mount'],
        'the names leave their conditional rules; the other names stay');
    assert.equal(out.syscalls.filter((r) => r.names.includes('sethostname')).length, 1);
    assert.deepEqual(source, fixture(), 'the source profile is not modified');
});

test('allowSyscalls is idempotent', () => {
    const once = allowSyscalls(fixture(), ['sethostname']);
    assert.deepEqual(allowSyscalls(once, ['sethostname']), once);
});

/** A template root with "boxed": a seccomp hook and a shipped fallback profile. */
function boxedRoot({ hook = true } = {}) {
    const root = mkdtempSync(join(tmpdir(), 'sandbox-test-'));
    const dir = join(root, 'boxed');
    mkdirSync(join(dir, '.devcontainer'), { recursive: true });
    writeFileSync(join(dir, 'devcontainer-template.json'), JSON.stringify({
        id: 'boxed',
        ...(hook && { 'x-sandbox': { seccompAllow: ['sethostname', 'setdomainname'] } }),
    }));
    writeFileSync(join(dir, '.devcontainer', 'devcontainer.json'), '{}');
    const shipped = fixture();
    shipped.syscalls.push({ names: ['shipped_marker'], action: 'SCMP_ACT_ALLOW' });
    writeFileSync(join(dir, '.devcontainer', 'seccomp.json'), JSON.stringify(shipped));
    return root;
}

test('a template with seccompAllow gets the host default plus those calls', () => {
    const root = boxedRoot();
    const host = join(root, 'host-seccomp.json');
    writeFileSync(host, JSON.stringify(fixture()));
    const dest = join(root, 'out');
    const messages = [];
    applyTemplate('boxed', dest, {}, root, { seccompSource: () => host, log: (m) => messages.push(m) });
    const profile = JSON.parse(readFileSync(join(dest, '.devcontainer', 'seccomp.json'), 'utf8'));
    assert.deepEqual(allowedOutright(profile), ['read', 'setdomainname', 'sethostname', 'write']);
    assert.match(messages.join('\n'), new RegExp(`from ${host}`));
});

test('without a host profile the shipped one is used, with a warning', () => {
    const root = boxedRoot();
    const dest = join(root, 'out');
    const messages = [];
    applyTemplate('boxed', dest, {}, root, { seccompSource: () => null, log: (m) => messages.push(m) });
    const profile = JSON.parse(readFileSync(join(dest, '.devcontainer', 'seccomp.json'), 'utf8'));
    assert.ok(allowedOutright(profile).includes('shipped_marker'));
    assert.ok(allowedOutright(profile).includes('sethostname'));
    assert.match(messages.join('\n'), /warning/i);
});

test('a template without seccompAllow is copied as it is', () => {
    const root = boxedRoot({ hook: false });
    const dest = join(root, 'out');
    applyTemplate('boxed', dest, {}, root, { seccompSource: () => assert.fail('not asked') });
    const profile = JSON.parse(readFileSync(join(dest, '.devcontainer', 'seccomp.json'), 'utf8'));
    assert.ok(!allowedOutright(profile).includes('sethostname'));
});

test('writeSeccompProfile fails clearly when there is neither a host nor a shipped profile', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sandbox-test-'));
    assert.throws(() => writeSeccompProfile(dir, ['sethostname'], { seccompSource: () => null, log: () => {} }),
        /seccomp/);
    assert.ok(!existsSync(join(dir, '.devcontainer', 'seccomp.json')));
});

test('a failed profile leaves no half-made sandbox behind', () => {
    const root = boxedRoot();
    const bad = join(root, 'bad.json');
    writeFileSync(bad, 'not json');
    const dest = join(root, 'out');
    assert.throws(() => applyTemplate('boxed', dest, {}, root, { seccompSource: () => bad, log: () => {} }),
        /cannot read the seccomp profile/);
    assert.ok(!existsSync(dest));
});
