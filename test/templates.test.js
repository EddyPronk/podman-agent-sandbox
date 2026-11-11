import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, existsSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { SandboxError } from '../dist/devcontainer.js';
import { vmPolicy } from '../dist/vm.js';
import { CONFIG_MOUNT } from '../dist/workspace.js';
import {
    applyTemplate, checkMinVersion, experimentalImage, listTemplates, parseOptionArgs, resolveOptions, substitute,
    versionAtLeast, withImage, withPolicies, policyConfig, policyProblem, checkPolicies, hasNoNewPrivileges,
    hasRootShellCaps, rootShellRunArgs, ROOT_SHELL_CAPS, ROOT_SHELL_DROP,
} from '../dist/templates.js';

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

test('versionAtLeast and checkMinVersion: a config can ask for a newer sandbox', () => {
    assert.ok(versionAtLeast('0.8.0', '0.8.0'));
    assert.ok(versionAtLeast('0.10.0', '0.9.3'), 'numbers, not strings');
    assert.ok(versionAtLeast('1.0.0', '0.99.99'));
    assert.ok(!versionAtLeast('0.7.9', '0.8.0'));
    assert.ok(versionAtLeast('0.8.0-rc.1', '0.8.0'), 'a prerelease suffix is ignored');
    const config = (min) => ({ customizations: { 'podman-agent-sandbox': { version: 1, minVersion: min } } });
    assert.doesNotThrow(() => checkMinVersion({}, 'f', '0.8.0'), 'no marker: nothing to check');
    assert.doesNotThrow(() => checkMinVersion(config(undefined), 'f', '0.8.0'));
    assert.doesNotThrow(() => checkMinVersion(config('0.8.0'), 'f', '0.8.0'));
    assert.throws(() => checkMinVersion(config('0.9.0'), 'f', '0.8.1'), /f needs sandbox 0\.9\.0 or later, and this is 0\.8\.1/);
    assert.throws(() => checkMinVersion(config('0.9'), 'f', '0.8.0'), /minVersion must be a version like/);
    assert.throws(() => checkMinVersion(config(9), 'f', '0.8.0'), /minVersion must be a version like/);
});

test('no bundled template needs a newer sandbox than the release it ships in', () => {
    const version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
    for (const { id } of listTemplates()) {
        const config = JSON.parse(readFileSync(new URL(`../templates/${id}/.devcontainer/devcontainer.json`, import.meta.url), 'utf8'));
        assert.doesNotThrow(() => checkMinVersion(config, id, version), `${id}`);
    }
    // nested-containers relies on seccompAllow in the marker (0.7.0): older ones leave podman inside without sethostname.
    const containers = JSON.parse(readFileSync(new URL('../templates/nested-containers/.devcontainer/devcontainer.json', import.meta.url), 'utf8'));
    assert.equal(containers.customizations['podman-agent-sandbox'].minVersion, '0.7.0');
});

test('sandbox new refuses a template that needs a newer sandbox, and makes nothing', () => {
    const root = demoRoot();
    writeFileSync(join(root, 'demo', '.devcontainer', 'devcontainer.json'),
        JSON.stringify({ name: 'x', customizations: { 'podman-agent-sandbox': { version: 1, minVersion: '99.0.0' } } }));
    const dir = mkdtempSync(join(tmpdir(), 'sandbox-test-'));
    const result = spawnSync(process.execPath, [fileURLToPath(new URL('../bin/sandbox.js', import.meta.url)),
        'new', 'box', '--template', join(root, 'demo')], { encoding: 'utf8', env: { ...process.env, SANDBOX_DIR: dir } });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /needs sandbox 99\.0\.0 or later, and this is \d+\.\d+\.\d+: update sandbox/);
    assert.ok(!existsSync(join(dir, 'box')));
});

test('bundled templates include claude with its dot-folder', () => {
    const ids = listTemplates().map((t) => t.id);
    assert.ok(ids.includes('open-network'));
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

test('applyTemplate uses defaults and returns the metadata', () => {
    const root = demoRoot();
    const dest = join(root, 'box');
    assert.equal(applyTemplate('demo', dest, {}, root).id, 'demo');
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

test('every bundled template but nested-containers drops all capabilities and no-new-privileges', () => {
    // Nothing in them needs either: they run as the user (keep-id), with no setuid or file-capability
    // programs. nested-containers can't: nested podman needs newuidmap's file capabilities.
    const hardening = ['--cap-drop=all', '--security-opt=no-new-privileges'];
    for (const { id } of listTemplates()) {
        const config = JSON.parse(readFileSync(new URL(`../templates/${id}/.devcontainer/devcontainer.json`, import.meta.url), 'utf8'));
        for (const arg of hardening) {
            assert.equal(config.runArgs.includes(arg), id !== 'nested-containers', `${id}: runArgs ${arg}`);
        }
    }
});

test('every bundled template mounts its own .devcontainer read-only over the workspace', () => {
    // Else the agent could edit the config the next container creation uses (initializeCommand runs
    // on the host). The same string as CONFIG_MOUNT, which --workspace removes again.
    for (const { id } of listTemplates()) {
        const config = JSON.parse(readFileSync(new URL(`../templates/${id}/.devcontainer/devcontainer.json`, import.meta.url), 'utf8'));
        assert.ok(config.mounts.includes(CONFIG_MOUNT), `${id}: mounts has CONFIG_MOUNT`);
        assert.equal(config.workspaceMount, 'source=${localWorkspaceFolder},target=/workspace,type=bind', `${id}: workspace at /workspace`);
    }
});

test('every bundled template labels its container as a sandbox, with the version', () => {
    // stop and rm recognise sandboxes by it (sandboxReason), and refuse other containers.
    for (const { id } of listTemplates()) {
        const config = JSON.parse(readFileSync(new URL(`../templates/${id}/.devcontainer/devcontainer.json`, import.meta.url), 'utf8'));
        assert.ok(config.runArgs.includes('--label=podman-agent-sandbox=${localEnv:SANDBOX_VERSION}'), `${id}: runArgs label`);
    }
});

test('open-network, offline and proxy-client: the base image is an option, Debian trixie by default', () => {
    // The Containerfile's ARG default and the option's default must agree: a build without the
    // option (sandbox build on an old folder, the CLI by hand) gets the same image.
    for (const id of ['open-network', 'offline', 'proxy-client']) {
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
    applyTemplate('open-network', dest, { image: 'docker.io/library/ubuntu:26.04' });
    const config = JSON.parse(readFileSync(join(dest, '.devcontainer', 'devcontainer.json'), 'utf8'));
    assert.equal(config.build.args.BASE_IMAGE, 'docker.io/library/ubuntu:26.04');
});

test('withImage: --image is the option image; a different --option image= is refused', () => {
    assert.deepEqual(withImage({ a: '1' }, undefined), { a: '1' });
    assert.deepEqual(withImage({ a: '1' }, 'x:1'), { a: '1', image: 'x:1' });
    assert.deepEqual(withImage({ image: 'x:1' }, 'x:1'), { image: 'x:1' });
    assert.throws(() => withImage({ image: 'y:1' }, 'x:1'), /disagree/);
    assert.deepEqual(withImage({ image: 'docker.io/library/ubuntu:26.04' }, 'ubuntu:26.04'), { image: 'ubuntu:26.04' },
        'two spellings of the same image agree');
});

test('experimentalImage: anything but the default and Ubuntu 26.04, whatever the spelling', () => {
    const debian = 'docker.io/library/debian:trixie-slim';
    for (const image of ['ubuntu:26.04', 'docker.io/ubuntu:26.04', 'docker.io/library/ubuntu:26.04',
        'debian:trixie-slim', debian]) {
        assert.equal(experimentalImage(image, debian), false, image);
    }
    for (const image of ['ubuntu:24.04', 'someone/ubuntu:26.04', 'localhost/ubuntu:26.04', 'myreg:5000/ubuntu:26.04',
        'mcr.microsoft.com/devcontainers/typescript-node:5-24-trixie']) {
        assert.equal(experimentalImage(image, debian), true, image);
    }
    // A template from a path may declare the option without a default.
    assert.equal(experimentalImage('ubuntu:26.04', undefined), false);
    assert.equal(experimentalImage('ubuntu:24.04', undefined), true);
});

test('sandbox new --image: the image reaches the build args; templates without the option refuse it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sandbox-test-'));
    const sandbox = (...args) => spawnSync(process.execPath,
        [fileURLToPath(new URL('../bin/sandbox.js', import.meta.url)), ...args],
        { encoding: 'utf8', env: { ...process.env, SANDBOX_DIR: dir } });
    const made = sandbox('new', 'u26', '--template', 'open-network', '--image', 'docker.io/library/ubuntu:26.04');
    assert.equal(made.status, 0, made.stderr);
    const config = JSON.parse(readFileSync(join(dir, 'u26', '.devcontainer', 'devcontainer.json'), 'utf8'));
    assert.equal(config.build.args.BASE_IMAGE, 'docker.io/library/ubuntu:26.04');
    assert.doesNotMatch(made.stderr, /experimental/, 'Ubuntu 26.04 is tested');
    const other = sandbox('new', 'ts', '--template', 'proxy-client', '--image', 'mcr.microsoft.com/devcontainers/typescript-node:5-24-trixie');
    assert.equal(other.status, 0, other.stderr);
    assert.match(other.stderr, /warning: --image mcr\.microsoft\.com\/devcontainers\/typescript-node:5-24-trixie is experimental/);
    assert.match(other.stderr, /run 'sandbox inspect ts': it may show warnings about weaknesses/);
    const refused = sandbox('new', 'p', '--template', 'mitm-proxy', '--image', 'docker.io/library/ubuntu:26.04');
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /template 'mitm-proxy' has no image option; --image works with offline, open-network and proxy-client/);
    assert.ok(!existsSync(join(dir, 'p')), 'nothing is created');
    // A template from a path whose image option has no default: a warning, not a crash.
    const root = demoRoot();
    writeFileSync(join(root, 'demo', 'devcontainer-template.json'),
        JSON.stringify({ id: 'demo', options: { image: { type: 'string' } } }));
    const custom = sandbox('new', 'c', '--template', join(root, 'demo'), '--image', 'ubuntu:24.04');
    assert.equal(custom.status, 0, custom.stderr);
    assert.match(custom.stderr, /--image ubuntu:24\.04 is experimental \(tested: docker\.io\/library\/ubuntu:26\.04\)\./);
});

test('offline: no network, and no agent or Node.js', () => {
    // --network=none leaves only loopback: no DNS, no proxy. An agent couldn't reach its API.
    const dir = new URL('../templates/offline/.devcontainer/', import.meta.url);
    const config = JSON.parse(readFileSync(new URL('devcontainer.json', dir), 'utf8'));
    assert.ok(config.runArgs.includes('--network=none'));
    assert.ok(!config.runArgs.some((arg) => arg.startsWith('--network') && arg !== '--network=none'));
    assert.equal(config.features, undefined, 'no features: no Node.js, no Claude Code');
    assert.ok(!JSON.stringify(config).includes('containerEnv'), 'no proxy settings or NVM variables');
    assert.match(readFileSync(new URL('Containerfile', dir), 'utf8'), /^\s+make \\$/m);
});

test('nested-containers: the open-network template plus podman, and it says it weakens the sandbox', () => {
    const meta = listTemplates().find((t) => t.id === 'nested-containers');
    assert.ok(meta, 'bundled');
    assert.match(meta.description, /weaken/i);
    const dir = new URL('../templates/nested-containers/.devcontainer/', import.meta.url);
    const config = JSON.parse(readFileSync(new URL('devcontainer.json', dir), 'utf8'));
    assert.deepEqual(config.customizations?.['podman-agent-sandbox']?.seccompAllow, ['sethostname', 'setdomainname'],
        'in the config, so a template written into a project (--inplace) carries it');
    assert.equal(meta['x-sandbox'], undefined, 'no longer in the metadata');
    const open = JSON.parse(readFileSync(new URL('../templates/open-network/.devcontainer/devcontainer.json', import.meta.url), 'utf8'));
    assert.deepEqual(config.features, open.features, 'same features as open-network');
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
    for (const pkg of ['podman', 'uidmap', 'passt', 'aardvark-dns', 'nftables', 'libcap2-bin', 'python3']) {
        assert.match(containerfile, new RegExp(`^\\s+${pkg} \\\\$`, 'm'), `installs ${pkg}`);
    }
    // uv at a fixed release, not :latest: the image is the same whenever it's built.
    assert.match(containerfile, /^COPY --from=ghcr\.io\/astral-sh\/uv:\d+\.\d+\.\d+ \/uv \/uvx \/usr\/local\/bin\/$/m);
    // The subordinate ranges come from the build's ID map (subid-ranges.sh, tested below).
    assert.match(containerfile, /subid-ranges\.sh "\$SANDBOX_UID" \/proc\/self\/uid_map > \/etc\/subuid/);
    assert.match(containerfile, /subid-ranges\.sh "\$SANDBOX_UID" \/proc\/self\/gid_map > \/etc\/subgid/);
});

test('nested-containers: subordinate ID ranges fit the map keep-id will give the sandbox', () => {
    // subid-ranges.sh UID MAPFILE, run at build time on /proc/self/uid_map (or gid_map). Each range
    // must lie inside one extent of the running sandbox's map, or the kernel refuses the inner map.
    const script = fileURLToPath(new URL('../templates/nested-containers/.devcontainer/subid-ranges.sh', import.meta.url));
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
    // the inner map after ID 998 (NESTED: podman inside nested-containers inside nested-containers).
    assert.deepEqual(ranges('         0       1000          1\n         1          1        999\n      1000       1001      64536\n'),
        ['1000:1:998', '1000:999:1', '1000:1001:64535']);
});

test('mitm-proxy: approve, vault and gatekeeper on PATH, and a HELP that names them and the allowlist', () => {
    const dir = new URL('../templates/mitm-proxy/.devcontainer/', import.meta.url);
    const containerfile = readFileSync(new URL('Containerfile', dir), 'utf8');
    assert.match(containerfile, /for command in approve vault gatekeeper; do\s*\\\s*ln -s \/opt\/agent-mitm-proxy\/venv\/bin\/\$command \/usr\/local\/bin\/\$command;/);
    const help = readFileSync(new URL('HELP', dir), 'utf8');
    for (const command of ['approve', 'vault clients', 'gatekeeper init']) {
        assert.ok(help.includes(`sandbox exec \${localWorkspaceFolderBasename} ${command}`), command);
    }
    assert.match(help, /\$\{localWorkspaceFolder\}\/allowlist\.txt/);
});

test('mitm-proxy: credentialVault reaches the proxy as AGENT_MITM_PROXY_CREDENTIAL_VAULT, on by default', () => {
    const env = (given) => {
        const dest = join(mkdtempSync(join(tmpdir(), 'sandbox-test-')), 'proxy');
        applyTemplate('mitm-proxy', dest, given);
        const config = JSON.parse(readFileSync(join(dest, '.devcontainer', 'devcontainer.json'), 'utf8'));
        return config.containerEnv.AGENT_MITM_PROXY_CREDENTIAL_VAULT;
    };
    assert.equal(env({}), '1');
    assert.equal(env({ credentialVault: '0' }), '0');
    assert.throws(() => env({ credentialVault: 'yes' }), /option 'credentialVault' must be one of 0, 1, not 'yes'/);
});

test('mitm-proxy: clientAuth reaches the proxy as AGENT_MITM_PROXY_CLIENT_AUTH, off by default', () => {
    const env = (given) => {
        const dest = join(mkdtempSync(join(tmpdir(), 'sandbox-test-')), 'proxy');
        applyTemplate('mitm-proxy', dest, given);
        const config = JSON.parse(readFileSync(join(dest, '.devcontainer', 'devcontainer.json'), 'utf8'));
        return config.containerEnv.AGENT_MITM_PROXY_CLIENT_AUTH;
    };
    assert.equal(env({}), '0');
    assert.equal(env({ clientAuth: '1' }), '1');
    assert.throws(() => env({ clientAuth: 'yes' }), /option 'clientAuth' must be one of 0, 1, not 'yes'/);
});

test('proxy-client: the proxy settings come from proxy.env, which initializeCommand writes', () => {
    const dest = join(mkdtempSync(join(tmpdir(), 'sandbox-test-')), 'client');
    applyTemplate('proxy-client', dest, { clientAuth: '1' });
    const config = JSON.parse(readFileSync(join(dest, '.devcontainer', 'devcontainer.json'), 'utf8'));
    assert.match(config.initializeCommand, /sh \.devcontainer\/proxy-env\.sh "\$\{localWorkspaceFolderBasename\}" "1"$/);
    assert.ok(config.runArgs.includes('--env-file=${localWorkspaceFolder}/proxy.env'));
    assert.ok(!('HTTPS_PROXY' in config.containerEnv), 'not also in containerEnv');
    assert.match(config.postCreateCommand, /; proxy-credentials fetch \|\| true;/);
    assert.ok(existsSync(join(dest, '.devcontainer', 'proxy-credentials')));
});

/** Run the proxy-client template's proxy-env.sh in DIR, with a stand-in podman that prints ENROLL. */
function proxyEnv(dir, auth, enroll = 'enrolled box; its proxy URL (shown once):\nhttp://box:t0ken@proxy:8899\ngranted entry e1') {
    const bin = join(dir, 'bin');
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, 'podman'), `#!/bin/sh\necho "$@" >>"${join(dir, 'podman-calls')}"\nprintf '%s\\n' '${enroll.replaceAll('\n', "' '")}'\n`,
        { mode: 0o755 });
    const script = fileURLToPath(new URL('../templates/proxy-client/.devcontainer/proxy-env.sh', import.meta.url));
    return spawnSync('sh', [script, 'box', auth], { cwd: dir, encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
}

test('proxy-env.sh: the plain URL without clientAuth; with it, enrols once and keeps the token', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sandbox-test-'));
    const env = () => readFileSync(join(dir, 'proxy.env'), 'utf8');
    assert.equal(proxyEnv(dir, '0').status, 0);
    assert.match(env(), /^HTTPS_PROXY=http:\/\/proxy:8899$/m);
    assert.ok(!existsSync(join(dir, 'podman-calls')), 'no enrolment without clientAuth');

    const first = proxyEnv(dir, '1');
    assert.equal(first.status, 0, first.stderr);
    assert.equal(env().split('\n').filter(Boolean).length, 4);
    assert.match(env(), /^https_proxy=http:\/\/box:t0ken@proxy:8899$/m);
    assert.equal(statSync(join(dir, 'proxy.env')).mode & 0o777, 0o600);
    assert.match(readFileSync(join(dir, 'podman-calls'), 'utf8'), /^exec proxy \S+\/vault enroll box$/m);

    assert.equal(proxyEnv(dir, '1').status, 0);
    assert.equal(readFileSync(join(dir, 'podman-calls'), 'utf8').split('\n').filter(Boolean).length, 1,
        'enrolled once: a second start keeps the token');
});

test('proxy-env.sh: an unexpected answer from the proxy writes nothing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sandbox-test-'));
    const result = proxyEnv(dir, '1', 'something else');
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /unexpected answer/);
    assert.ok(!existsSync(join(dir, 'proxy.env')));
});

test('every bundled template with Node.js pins its major version, not whatever lts is today', () => {
    // lts moved to 26 in October 2026, whose binary needs libatomic, which the slim images lack:
    // every build failed until the templates said which Node.js they want.
    for (const { id } of listTemplates()) {
        const config = JSON.parse(readFileSync(new URL(`../templates/${id}/.devcontainer/devcontainer.json`, import.meta.url), 'utf8'));
        const node = config.features?.['ghcr.io/devcontainers/features/node:1'];
        if (node) assert.equal(node.version, '24', id);
    }
});

test('templates with an agent: Claude Code is their default agent, not part of the template', () => {
    for (const name of ['open-network', 'nested-containers', 'proxy-client']) {
        const dir = fileURLToPath(new URL(`../templates/${name}/.devcontainer/`, import.meta.url));
        const config = JSON.parse(readFileSync(join(dir, 'devcontainer.json'), 'utf8'));
        assert.equal(config.customizations['podman-agent-sandbox'].agent, 'claude-code', name);
        assert.ok(!Object.keys(config.features).some((ref) => ref.includes('claude-code')), `${name}: no claude-code Feature`);
        assert.doesNotMatch(JSON.stringify(config), /trust-workspace|DISABLE_AUTOUPDATER/, name);
        assert.ok(!existsSync(join(dir, 'trust-workspace')), `${name}: the script is the agent's`);
    }
});

test('trust-workspace records the folder as trusted in ~/.claude.json, keeping what is there', () => {
    const home = mkdtempSync(join(tmpdir(), 'sandbox-test-'));
    const script = fileURLToPath(new URL('../agents/claude-code/trust-workspace', import.meta.url));
    const run = (...args) => spawnSync('sh', [script, ...args], { encoding: 'utf8', env: { ...process.env, HOME: home } });
    const config = () => JSON.parse(readFileSync(join(home, '.claude.json'), 'utf8'));

    assert.equal(run('/workspace').status, 0);
    assert.deepEqual(config().projects['/workspace'], { hasTrustDialogAccepted: true });
    assert.equal(statSync(join(home, '.claude.json')).mode & 0o777, 0o600);

    writeFileSync(join(home, '.claude.json'), JSON.stringify({
        hasCompletedOnboarding: true, projects: { '/home/u/project': { allowedTools: ['x'] } },
    }));
    assert.equal(run('/home/u/project').status, 0);
    assert.equal(config().hasCompletedOnboarding, true);
    assert.deepEqual(config().projects['/home/u/project'], { allowedTools: ['x'], hasTrustDialogAccepted: true });

    assert.equal(run().status, 2, 'no folder: usage');
});

test('template metadata without an id, or with malformed options, is refused with a message', () => {
    for (const metadata of [{}, { id: 7 }, { id: 'bad', options: [] }, { id: 'bad', options: { o: { enum: 'a|b' } } },
        { id: 'bad', options: { o: { default: 1 } } }]) {
        const root = demoRoot();
        const file = join(root, 'demo', 'devcontainer-template.json');
        writeFileSync(file, JSON.stringify(metadata));
        const isRefusal = (err) => err instanceof SandboxError && err.message.includes(`${file} isn't a template's metadata`);
        assert.throws(() => listTemplates(root), isRefusal, JSON.stringify(metadata));
        assert.throws(() => applyTemplate(join(root, 'demo'), join(root, 'out'), {}, root), isRefusal);
        assert.ok(!existsSync(join(root, 'out')));
    }
});

test('a seccompAllow that is not a list of names is refused, and nothing is left behind', () => {
    const root = demoRoot();
    const config = join(root, 'demo', '.devcontainer', 'devcontainer.json');
    for (const allow of ['"sethostname"', '[1]', '{}']) {
        writeFileSync(config, `{"customizations": {"podman-agent-sandbox": {"seccompAllow": ${allow}}}}`);
        assert.throws(() => applyTemplate('demo', join(root, 'out'), {}, root, { seccompSource: () => assert.fail('not asked') }),
            (err) => err instanceof SandboxError && /seccompAllow must be a list of system call names/.test(err.message), allow);
        assert.ok(!existsSync(join(root, 'out')));
    }
});

test('null in template metadata and in seccompAllow reads as unset', () => {
    const root = demoRoot();
    writeFileSync(join(root, 'demo', 'devcontainer-template.json'), JSON.stringify({
        id: 'demo', description: null,
        options: { network: { type: 'string', enum: null, proposals: null, description: null, default: 'offline' } },
        'x-sandbox': { seccompAllow: null },
    }));
    writeFileSync(join(root, 'demo', '.devcontainer', 'devcontainer.json'),
        '{"customizations": {"podman-agent-sandbox": {"seccompAllow": null}}}');
    assert.deepEqual(listTemplates(root).map((t) => t.id), ['demo']);
    applyTemplate('demo', join(root, 'out'), {}, root, { seccompSource: () => assert.fail('not asked') });
    assert.ok(!existsSync(join(root, 'out', '.devcontainer', 'seccomp.json')));
    const options = mkdtempSync(join(tmpdir(), 'sandbox-test-'));
    mkdirSync(join(options, 'demo', '.devcontainer'), { recursive: true });
    writeFileSync(join(options, 'demo', 'devcontainer-template.json'), JSON.stringify({ id: 'demo', options: null }));
    assert.deepEqual(listTemplates(options)[0].options, null);
});

test('mitm-proxy: the gatekeeper starts after the proxy', () => {
    const dest = join(mkdtempSync(join(tmpdir(), 'sandbox-test-')), 'proxy');
    applyTemplate('mitm-proxy', dest, {});
    const config = JSON.parse(readFileSync(join(dest, '.devcontainer', 'devcontainer.json'), 'utf8'));
    assert.equal(config.postStartCommand,
        '/opt/agent-mitm-proxy/scripts/start-proxy.sh && /opt/agent-mitm-proxy/scripts/start-gatekeeper.sh');
});

test('proxy-client: Claude Code gets the gatekeeper when the container is made', () => {
    const dest = join(mkdtempSync(join(tmpdir(), 'sandbox-test-')), 'client');
    applyTemplate('proxy-client', dest, {});
    const config = JSON.parse(readFileSync(join(dest, '.devcontainer', 'devcontainer.json'), 'utf8'));
    assert.match(config.postCreateCommand, /; proxy-gatekeeper connect \|\| true$/);
    assert.ok(existsSync(join(dest, '.devcontainer', 'proxy-gatekeeper')));
    assert.match(readFileSync(join(dest, 'CLAUDE.md'), 'utf8'), /request_allowlist/);
});

/** Run proxy-gatekeeper connect in DIR, with stand-ins: curl prints STATUS, claude knows the server if HAS. */
function proxyGatekeeper(dir, status, has = false) {
    const bin = join(dir, 'bin');
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, 'curl'), `#!/bin/sh\nprintf '%s' '${status}'\n[ '${status}' != 000 ]\n`, { mode: 0o755 });
    writeFileSync(join(bin, 'claude'), `#!/bin/sh\necho "$@" >>"${join(dir, 'claude-calls')}"\n`
        + `[ "$2" != get ] || ${has ? 'exit 0' : 'exit 1'}\n`, { mode: 0o755 });
    const script = fileURLToPath(new URL('../templates/proxy-client/.devcontainer/proxy-gatekeeper', import.meta.url));
    return spawnSync('sh', [script, 'connect'], { cwd: dir, encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
}

test('proxy-gatekeeper: adds the MCP server only when the gatekeeper answers, and only once', () => {
    const calls = (dir) => existsSync(join(dir, 'claude-calls')) ? readFileSync(join(dir, 'claude-calls'), 'utf8') : '';
    const none = mkdtempSync(join(tmpdir(), 'sandbox-test-'));
    const unreachable = proxyGatekeeper(none, '000');
    assert.equal(unreachable.status, 1);
    assert.match(unreachable.stderr, /no gatekeeper at http:\/\/proxy:8900\/mcp/);
    assert.equal(calls(none), '', 'Claude Code untouched');

    const fresh = mkdtempSync(join(tmpdir(), 'sandbox-test-'));
    assert.equal(proxyGatekeeper(fresh, '400').status, 0);
    assert.match(calls(fresh), /^mcp add --scope user --transport http allowlist http:\/\/proxy:8900\/mcp$/m);

    const known = mkdtempSync(join(tmpdir(), 'sandbox-test-'));
    const again = proxyGatekeeper(known, '400', true);
    assert.equal(again.status, 0);
    assert.match(again.stdout, /already has/);
    assert.doesNotMatch(calls(known), /mcp add/);
});

test('templates: every file a Containerfile COPYs from its build context is there', () => {
    for (const id of readdirSync(new URL('../templates/', import.meta.url))) {
        const dir = fileURLToPath(new URL(`../templates/${id}/.devcontainer/`, import.meta.url));
        if (!existsSync(join(dir, 'Containerfile'))) continue;
        for (const line of readFileSync(join(dir, 'Containerfile'), 'utf8').split('\n')) {
            const copy = line.match(/^COPY\s+(?!--from)(\S+)\s+\S+/);
            if (copy) assert.ok(existsSync(join(dir, copy[1])), `${id}: COPY ${copy[1]}`);
        }
    }
});

test('claude still works: the old name of open-network, not listed', () => {
    const dest = join(mkdtempSync(join(tmpdir(), 'sandbox-test-')), 'old');
    const template = applyTemplate('claude', dest, {});
    assert.equal(template.id, 'open-network');
    const config = JSON.parse(readFileSync(join(dest, '.devcontainer', 'devcontainer.json'), 'utf8'));
    assert.equal(config.customizations['podman-agent-sandbox'].agent, 'claude-code');
    assert.ok(!listTemplates().some((t) => t.id === 'claude'), 'not listed: the old name only resolves');
    const dir = mkdtempSync(join(tmpdir(), 'sandbox-test-'));
    const made = spawnSync(process.execPath, [fileURLToPath(new URL('../bin/sandbox.js', import.meta.url)),
        'new', 'old', '--template', 'claude'], { encoding: 'utf8', env: { ...process.env, SANDBOX_DIR: dir } });
    assert.equal(made.status, 0, made.stderr);
    assert.match(made.stdout, /from template 'open-network' \(given by its old name, 'claude'\)/);
    assert.ok(existsSync(join(dir, 'old', '.devcontainer', 'agent', 'claude-code')), 'with its default agent');
});

test('open-network says what its network reaches, and where to go for less', () => {
    const meta = listTemplates().find((t) => t.id === 'open-network');
    assert.match(meta.description, /Internet, your LAN and services on your machine/);
    assert.match(meta.description, /proxy-client or offline/);
});

test('withPolicies lists a policy and leaves runArgs as written: root-shell applies when the container is made', () => {
    const config = { runArgs: ['--userns=keep-id', '--cap-drop=all', '--security-opt=no-new-privileges'] };
    const root = withPolicies(config, ['root-shell']);
    assert.deepEqual(root.runArgs, config.runArgs);
    assert.deepEqual(root.customizations['podman-agent-sandbox'].policies, ['root-shell']);
    assert.equal(policyConfig(config), null, 'no policy: made from the config as it is');
    assert.equal(policyConfig(withPolicies(config, ['git-readonly'])), null);
    assert.deepEqual(policyConfig(root).runArgs,
        ['--userns=keep-id', '--security-opt=no-new-privileges', `--cap-drop=${ROOT_SHELL_DROP.join(',')}`]);
    assert.equal(root.runArgs.length, 3, 'the config given is unchanged');
});

test('rootShellRunArgs: "all" out of every spelling of --cap-drop, the six apt does not need dropped', () => {
    const drop = `--cap-drop=${ROOT_SHELL_DROP.join(',')}`;
    assert.deepEqual(rootShellRunArgs(['--cap-drop=ALL']), [drop]);
    assert.deepEqual(rootShellRunArgs(['--cap-drop', 'ALL', '--init']), ['--init', drop]);
    assert.deepEqual(rootShellRunArgs(['--cap-drop=all,NET_RAW', '--userns', 'keep-id']), ['--cap-drop=NET_RAW', '--userns', 'keep-id', drop]);
    assert.deepEqual(rootShellRunArgs(['--cap-drop=CAP_ALL']), [drop]);
    assert.deepEqual(rootShellRunArgs([]), [drop]);
    // Not with --cap-add: podman gives added capabilities to a non-root user too (lab 51).
    assert.ok(!rootShellRunArgs(['--cap-drop=all']).some((arg) => String(arg).startsWith('--cap-add')));
});

test('root-shell needs no-new-privileges, in either spelling', () => {
    const listed = (runArgs) => ({ runArgs, customizations: { 'podman-agent-sandbox': { policies: ['root-shell'] } } });
    assert.equal(hasNoNewPrivileges(['--security-opt=no-new-privileges']), true);
    assert.equal(hasNoNewPrivileges(['--security-opt', 'no-new-privileges:true']), true);
    assert.equal(hasNoNewPrivileges(['--security-opt=seccomp=x.json']), false);
    assert.equal(policyProblem(listed(['--security-opt=no-new-privileges'])), null);
    assert.match(policyProblem(listed(['--cap-drop=all'])), /root-shell policy needs --security-opt=no-new-privileges/);
    assert.equal(policyProblem({ runArgs: [] }), null, 'not listed: no problem');
    assert.throws(() => checkPolicies(listed([]), 'x.json'), /needs --security-opt=no-new-privileges.*x\.json has none/s);
    assert.equal(hasRootShellCaps(ROOT_SHELL_CAPS), true);
    assert.equal(hasRootShellCaps(['CAP_SYS_PTRACE']), false, 'a Feature\'s capAdd is not what apt needs');
});

test('sandbox new --policy root-shell: the config lists it, runArgs as the template wrote them; not for nested-containers', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sandbox-test-'));
    const sandbox = (...args) => spawnSync(process.execPath, [fileURLToPath(new URL('../bin/sandbox.js', import.meta.url)), ...args],
        { encoding: 'utf8', env: { ...process.env, SANDBOX_DIR: dir } });
    const made = sandbox('new', 'r', '--template', 'open-network', '--policy', 'root-shell');
    assert.equal(made.status, 0, made.stderr);
    const config = JSON.parse(readFileSync(join(dir, 'r', '.devcontainer', 'devcontainer.json'), 'utf8'));
    assert.deepEqual(config.customizations['podman-agent-sandbox'].policies, ['root-shell']);
    assert.ok(config.runArgs.includes('--cap-drop=all'));
    // nested-containers has no no-new-privileges (newuidmap is setuid): refused, nothing left behind.
    const nested = sandbox('new', 'n', '--template', 'nested-containers', '--policy', 'root-shell');
    assert.equal(nested.status, 1);
    assert.match(nested.stderr, /root-shell policy needs --security-opt=no-new-privileges/);
    assert.equal(existsSync(join(dir, 'n')), false);
    // Nor for a VM: its runArgs would only weaken the VM's host process.
    const vm = vmPolicy(config);
    assert.equal(vm.allowed, false);
    assert.match(vm.reason, /policies include root-shell, which is for sandbox enter --root, in a container/);
});

test('claude-containers still works: the old name of nested-containers', () => {
    const dest = join(mkdtempSync(join(tmpdir(), 'sandbox-test-')), 'old');
    const template = applyTemplate('claude-containers', dest, {});
    assert.equal(template.id, 'nested-containers');
    const config = JSON.parse(readFileSync(join(dest, '.devcontainer', 'devcontainer.json'), 'utf8'));
    assert.deepEqual(config.customizations['podman-agent-sandbox'].seccompAllow, ['sethostname', 'setdomainname']);
    assert.ok(!listTemplates().some((t) => t.id === 'claude-containers'), 'not listed: the old name only resolves');
});
