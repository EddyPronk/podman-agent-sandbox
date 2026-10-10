import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdirSync, mkdtempSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { SandboxError } from '../src/devcontainer.js';
import { applyTemplate, listTemplates, parseOptionArgs, resolveOptions, substitute, withImage } from '../src/templates.js';

/** A template root with one template "demo" that has a network option. */
function demoRoot() {
    const root = mkdtempSync(join(tmpdir(), 'sandbox-test-'));
    const dir = join(root, 'demo');
    mkdirSync(join(dir, '.devcontainer'), { recursive: true });
    writeFileSync(join(dir, 'devcontainer-template.json'), JSON.stringify({
        id: 'demo',
        options: {
            network: { type: 'string', enum: ['offline', 'internet'], default: 'offline' },
            debug: { type: 'boolean', default: false },
        },
    }));
    writeFileSync(join(dir, '.devcontainer', 'devcontainer.json'),
        '{"name": "${localWorkspaceFolderBasename}", "net": "${templateOption:network}", "x": "${templateOption:nope}"}');
    return root;
}

test('bundled templates include claude with its dot-folder', () => {
    const ids = listTemplates().map((t) => t.id);
    assert.ok(ids.includes('claude'));
});

test('applyTemplate copies, substitutes and drops the metadata file', () => {
    const root = demoRoot();
    const dest = join(root, 'out', 'box');
    applyTemplate('demo', dest, { network: 'internet' }, root);
    const config = readFileSync(join(dest, '.devcontainer', 'devcontainer.json'), 'utf8');
    assert.match(config, /"net": "internet"/);
    assert.match(config, /\$\{localWorkspaceFolderBasename\}/, 'other variables are left for the CLI');
    assert.match(config, /\$\{templateOption:nope\}/, 'unknown options are left as they are');
    assert.ok(!existsSync(join(dest, 'devcontainer-template.json')));
});

test('applyTemplate uses defaults', () => {
    const root = demoRoot();
    const dest = join(root, 'box');
    applyTemplate('demo', dest, {}, root);
    assert.match(readFileSync(join(dest, '.devcontainer', 'devcontainer.json'), 'utf8'), /"net": "offline"/);
});

test('applyTemplate refuses an existing folder and unknown ids', () => {
    const root = demoRoot();
    assert.throws(() => applyTemplate('demo', root, {}, root), /already exists/);
    assert.throws(() => applyTemplate('nope', join(root, 'a'), {}, root), /no template 'nope'/);
});

test('a path applies a template folder outside the bundled ones', () => {
    const root = demoRoot();
    const dest = join(root, 'from-path');
    // Bundled root is somewhere else entirely: the path alone finds the template.
    applyTemplate(join(root, 'demo'), dest, { network: 'internet' }, mkdtempSync(join(tmpdir(), 'empty-')));
    assert.match(readFileSync(join(dest, '.devcontainer', 'devcontainer.json'), 'utf8'), /"net": "internet"/);
    assert.ok(!existsSync(join(dest, 'devcontainer-template.json')));
});

test('a path without template metadata is refused', () => {
    const root = demoRoot();
    assert.throws(() => applyTemplate(join(root, 'demo', '.devcontainer'), join(root, 'x'), {}, root),
        /no template at .* \(it has no devcontainer-template.json\)/);
});

test('a bare id never leaves the bundled templates', () => {
    const root = demoRoot();
    // 'demo' exists one level up from this root; without a '/' it is looked up as an id only.
    assert.throws(() => applyTemplate('..', join(root, 'y'), {}, join(root, 'demo')), SandboxError);
});

test('resolveOptions checks names, enums and booleans', () => {
    const template = JSON.parse(readFileSync(join(demoRoot(), 'demo', 'devcontainer-template.json'), 'utf8'));
    assert.deepEqual(resolveOptions(template, {}), { network: 'offline', debug: 'false' });
    assert.throws(() => resolveOptions(template, { colour: 'red' }), /no option 'colour'/);
    assert.throws(() => resolveOptions(template, { network: 'proxy' }), /must be one of/);
    assert.throws(() => resolveOptions(template, { debug: 'yes' }), /true or false/);
});

test('parseOptionArgs splits on the first =', () => {
    assert.deepEqual(parseOptionArgs(['a=1', 'b=x=y', 'c=']), { a: '1', b: 'x=y', c: '' });
    assert.throws(() => parseOptionArgs(['novalue']), /KEY=VALUE/);
    assert.throws(() => parseOptionArgs(['=1']), /KEY=VALUE/);
});

test('substitute replaces every occurrence', () => {
    assert.equal(substitute('${templateOption:a}-${templateOption:a}', { a: 'x' }), 'x-x');
});

test('every bundled template sets USER and LOGNAME in sandbox enter shells', () => {
    // Nothing logs in inside a container, so shells there have no USER/LOGNAME unless the
    // template passes them in; `sandbox` itself fills USER in when it's missing (childEnv).
    for (const { id } of listTemplates()) {
        const config = JSON.parse(readFileSync(new URL(`../templates/${id}/.devcontainer/devcontainer.json`, import.meta.url), 'utf8'));
        assert.equal(config.remoteEnv?.USER, '${localEnv:USER}', `${id}: remoteEnv.USER`);
        assert.equal(config.remoteEnv?.LOGNAME, '${localEnv:USER}', `${id}: remoteEnv.LOGNAME`);
    }
});

test('every bundled template but claude-containers drops all capabilities and no-new-privileges', () => {
    // Nothing in them needs either: they run as the user (keep-id), with no setuid or file-capability
    // programs. claude-containers can't: nested podman needs newuidmap's file capabilities.
    const hardening = ['--cap-drop=all', '--security-opt=no-new-privileges'];
    for (const { id } of listTemplates()) {
        const config = JSON.parse(readFileSync(new URL(`../templates/${id}/.devcontainer/devcontainer.json`, import.meta.url), 'utf8'));
        for (const arg of hardening) {
            assert.equal(config.runArgs.includes(arg), id !== 'claude-containers', `${id}: runArgs ${arg}`);
        }
    }
});

test('every bundled template labels its container as a sandbox, with the version', () => {
    // stop and rm recognise sandboxes by it (sandboxReason), and refuse other containers.
    for (const { id } of listTemplates()) {
        const config = JSON.parse(readFileSync(new URL(`../templates/${id}/.devcontainer/devcontainer.json`, import.meta.url), 'utf8'));
        assert.ok(config.runArgs.includes('--label=podman-agent-sandbox=${localEnv:SANDBOX_VERSION}'), `${id}: runArgs label`);
    }
});

test('claude and proxy-client: the base image is an option, Debian trixie by default', () => {
    // The Containerfile's ARG default and the option's default must agree: a build without the
    // option (sandbox build on an old folder, the CLI by hand) gets the same image.
    for (const id of ['claude', 'proxy-client']) {
        const dir = new URL(`../templates/${id}/`, import.meta.url);
        const containerfile = readFileSync(new URL('.devcontainer/Containerfile', dir), 'utf8');
        const config = JSON.parse(readFileSync(new URL('.devcontainer/devcontainer.json', dir), 'utf8'));
        const option = listTemplates().find((t) => t.id === id).options.image;
        const arg = containerfile.match(/^ARG BASE_IMAGE=(\S+)$/m);
        assert.ok(arg, `${id}: ARG BASE_IMAGE with a default`);
        assert.ok(arg.index < containerfile.indexOf('FROM ${BASE_IMAGE}'), `${id}: ARG before FROM \${BASE_IMAGE}`);
        assert.equal(option.default, 'docker.io/library/debian:trixie-slim', `${id}: option default`);
        assert.equal(arg[1], option.default, `${id}: ARG default = option default`);
        assert.ok(option.proposals.includes('docker.io/library/ubuntu:26.04'), `${id}: Ubuntu 26.04 proposed`);
        assert.deepEqual(config.build.args, {
            BASE_IMAGE: '${templateOption:image}',
            SANDBOX_UID: '${localEnv:SANDBOX_UID:1000}',
            SANDBOX_USER: '${localEnv:USER}',
        }, `${id}: build.args`);
        // The image's own user with our UID (ubuntu, node) is renamed, or keep-id leaves $USER out.
        assert.match(containerfile, /usermod -l "\$SANDBOX_USER"/, `${id}: renames a user with our UID`);
    }
});

test('applying claude with image puts that image in the build args', () => {
    const dest = join(mkdtempSync(join(tmpdir(), 'sandbox-test-')), 'box');
    applyTemplate('claude', dest, { image: 'docker.io/library/ubuntu:26.04' });
    const config = JSON.parse(readFileSync(join(dest, '.devcontainer', 'devcontainer.json'), 'utf8'));
    assert.equal(config.build.args.BASE_IMAGE, 'docker.io/library/ubuntu:26.04');
});

test('withImage: --image is the option image; a different --option image= is refused', () => {
    assert.deepEqual(withImage({ a: '1' }, undefined), { a: '1' });
    assert.deepEqual(withImage({ a: '1' }, 'x:1'), { a: '1', image: 'x:1' });
    assert.deepEqual(withImage({ image: 'x:1' }, 'x:1'), { image: 'x:1' });
    assert.throws(() => withImage({ image: 'y:1' }, 'x:1'), /disagree/);
});

test('sandbox new --image: the image reaches the build args; templates without the option refuse it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sandbox-test-'));
    const sandbox = (...args) => spawnSync(process.execPath,
        [fileURLToPath(new URL('../bin/sandbox.js', import.meta.url)), ...args],
        { encoding: 'utf8', env: { ...process.env, SANDBOX_DIR: dir } });
    const made = sandbox('new', 'u26', '--template', 'claude', '--image', 'docker.io/library/ubuntu:26.04');
    assert.equal(made.status, 0, made.stderr);
    const config = JSON.parse(readFileSync(join(dir, 'u26', '.devcontainer', 'devcontainer.json'), 'utf8'));
    assert.equal(config.build.args.BASE_IMAGE, 'docker.io/library/ubuntu:26.04');
    const refused = sandbox('new', 'p', '--template', 'mitm-proxy', '--image', 'docker.io/library/ubuntu:26.04');
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /template 'mitm-proxy' has a fixed image \(no --image\)/);
    assert.ok(!existsSync(join(dir, 'p')), 'nothing is created');
});

test('claude-containers: the claude template plus podman, and it says it weakens the sandbox', () => {
    const meta = listTemplates().find((t) => t.id === 'claude-containers');
    assert.ok(meta, 'bundled');
    assert.match(meta.description, /weaken/i);
    assert.deepEqual(meta['x-sandbox']?.seccompAllow, ['sethostname', 'setdomainname']);
    const dir = new URL('../templates/claude-containers/.devcontainer/', import.meta.url);
    const config = JSON.parse(readFileSync(new URL('devcontainer.json', dir), 'utf8'));
    const claude = JSON.parse(readFileSync(new URL('../templates/claude/.devcontainer/devcontainer.json', import.meta.url), 'utf8'));
    assert.deepEqual(config.features, claude.features, 'same features as claude');
    for (const arg of ['--userns=keep-id', '--device=/dev/net/tun', '--security-opt=unmask=/proc/*',
        '--security-opt=seccomp=${localWorkspaceFolder}/.devcontainer/seccomp.json']) {
        assert.ok(config.runArgs.includes(arg), `runArgs has ${arg}`);
    }
    assert.equal(config.build.args?.SANDBOX_UID, '${localEnv:SANDBOX_UID:1000}');
    assert.match(config.postCreateCommand, /PAS_VERSION=\$\{localEnv:SANDBOX_VERSION\}/,
        'installs the same sandbox version inside as outside');
    // The shipped fallback profile is podman's default, still without the two calls.
    const shipped = JSON.parse(readFileSync(new URL('seccomp.json', dir), 'utf8'));
    assert.ok(shipped.syscalls.length > 10);
    const containerfile = readFileSync(new URL('Containerfile', dir), 'utf8');
    for (const pkg of ['podman', 'uidmap', 'passt', 'aardvark-dns', 'nftables', 'libcap2-bin']) {
        assert.match(containerfile, new RegExp(`^\\s+${pkg} \\\\$`, 'm'), `installs ${pkg}`);
    }
    // The subordinate ranges come from the build's ID map (subid-ranges.sh, tested below).
    assert.match(containerfile, /subid-ranges\.sh "\$SANDBOX_UID" \/proc\/self\/uid_map > \/etc\/subuid/);
    assert.match(containerfile, /subid-ranges\.sh "\$SANDBOX_UID" \/proc\/self\/gid_map > \/etc\/subgid/);
});

test('claude-containers: subordinate ID ranges fit the map keep-id will give the sandbox', () => {
    // subid-ranges.sh UID MAPFILE, run at build time on /proc/self/uid_map (or gid_map). Each range
    // must lie inside one extent of the running sandbox's map, or the kernel refuses the inner map.
    const script = fileURLToPath(new URL('../templates/claude-containers/.devcontainer/subid-ranges.sh', import.meta.url));
    const ranges = (map) => {
        const dir = mkdtempSync(join(tmpdir(), 'subid-'));
        writeFileSync(join(dir, 'map'), map);
        const r = spawnSync('sh', [script, '1000', join(dir, 'map')], { encoding: 'utf8' });
        assert.equal(r.status, 0, r.stderr);
        return r.stdout.trim().split('\n');
    };
    // A sandbox on a host with one subordinate range: as the lab template had it.
    assert.deepEqual(ranges('         0       1000          1\n         1     100000      65536\n'),
        ['1000:1:999', '1000:1001:64536']);
    // A sandbox in a sandbox: the outer one's own ID (1000) is a hole in its ranges, which splits
    // the inner map after ID 998 (NESTED: podman inside claude-containers inside claude-containers).
    assert.deepEqual(ranges('         0       1000          1\n         1          1        999\n      1000       1001      64536\n'),
        ['1000:1:998', '1000:999:1', '1000:1001:64535']);
});
