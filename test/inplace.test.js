import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
    chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
    KNOWN_POLICIES, MARKER_VERSION, checkMarker, checkSelfContained, configTree, hasMarker, resolveLocalEnv, riskSummary,
} from '../src/inplace.js';
import { listTemplates } from '../src/templates.js';

const SANDBOX = fileURLToPath(new URL('../bin/sandbox.js', import.meta.url));
const noGit = spawnSync('git', ['--version']).status !== 0;
const MARKER = { 'podman-agent-sandbox': { version: 1, policies: [] } };

function tempDir() {
    return realpathSync(mkdtempSync(join(tmpdir(), 'sandbox-test-')));
}

/** A project with a sandbox config of its own (CONFIG merged into a plain one). */
function project(config = {}) {
    const root = tempDir();
    mkdirSync(join(root, '.devcontainer'));
    writeFileSync(join(root, '.devcontainer', 'devcontainer.json'), JSON.stringify({
        image: 'docker.io/library/debian:trixie-slim', customizations: MARKER, ...config,
    }, null, 2));
    writeFileSync(join(root, '.devcontainer', 'Containerfile'), 'FROM docker.io/library/debian:trixie-slim\n');
    return root;
}

function git(dir, ...args) {
    const result = spawnSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args],
        { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
}

function sandbox(args, dir, cwd = process.cwd()) {
    return spawnSync(process.execPath, [SANDBOX, ...args],
        { encoding: 'utf8', cwd, env: { ...process.env, SANDBOX_DIR: dir }, stdio: ['ignore', 'pipe', 'pipe'] });
}

test('configTree equals git ls-tree HEAD for a committed config, also outside a repository', { skip: noGit }, () => {
    const root = project();
    git(root, 'init', '-q');
    git(root, 'add', '.devcontainer');
    git(root, 'commit', '-q', '-m', 'config');
    const committed = git(root, 'ls-tree', 'HEAD', '.devcontainer').split(/\s+/)[2];
    assert.equal(configTree(root), committed);
    const copy = tempDir();
    cpSync(join(root, '.devcontainer'), join(copy, '.devcontainer'), { recursive: true });
    assert.equal(configTree(copy), committed, 'the same files outside a repository give the same id');
    assert.equal(git(root, 'status', '--porcelain'), '', 'nothing written into the repository');
});

test('configTree sees edits, untracked files, mode changes and a missing folder', { skip: noGit }, () => {
    const root = project();
    const before = configTree(root);
    const file = join(root, '.devcontainer', 'devcontainer.json');
    const text = readFileSync(file, 'utf8');
    writeFileSync(file, `${text}\n`);
    assert.notEqual(configTree(root), before, 'edited');
    writeFileSync(file, text);
    assert.equal(configTree(root), before, 'restored');
    writeFileSync(join(root, '.devcontainer', 'extra.sh'), '');
    assert.notEqual(configTree(root), before, 'untracked file');
    rmSync(join(root, '.devcontainer', 'extra.sh'));
    chmodSync(file, 0o755);
    assert.notEqual(configTree(root), before, 'mode');
    chmodSync(file, 0o644);
    assert.equal(configTree(root), before);
    rmSync(join(root, '.devcontainer'), { recursive: true });
    assert.equal(configTree(root), '', 'no folder: empty');
});

test('checkMarker: no marker, a newer version, unknown policies are refused', () => {
    assert.equal(MARKER_VERSION, 1);
    assert.deepEqual(KNOWN_POLICIES, []);
    assert.doesNotThrow(() => checkMarker({ customizations: MARKER }, 'f'));
    assert.throws(() => checkMarker({}, 'f'), /isn't a sandbox config.*\n.*--template claude/s);
    assert.throws(() => checkMarker({ customizations: { vscode: {} } }, 'f'), /isn't a sandbox config/);
    assert.throws(() => checkMarker({ customizations: { 'podman-agent-sandbox': {} } }, 'f'), /needs a "version"/);
    assert.throws(() => checkMarker({ customizations: { 'podman-agent-sandbox': { version: 2 } } }, 'f'), /newer sandbox.*update sandbox/);
    assert.throws(() => checkMarker({ customizations: { 'podman-agent-sandbox': { version: 1, policies: ['rootless'] } } }, 'f'),
        /a policy this sandbox can't check: rootless/);
    assert.throws(() => checkMarker({ customizations: { 'podman-agent-sandbox': { version: 1, policies: 'x' } } }, 'f'), /must be a list/);
});

test('checkSelfContained: paths, Features, symlinks and initializeCommand files outside .devcontainer are refused', () => {
    const root = project();
    const dir = join(root, '.devcontainer');
    const ok = (config) => assert.doesNotThrow(() => checkSelfContained(config, dir, root));
    const refused = (config, pattern) => assert.throws(() => checkSelfContained(config, dir, root), pattern);
    ok({ build: { dockerfile: 'Containerfile', context: '.' }, features: { './local': {}, 'ghcr.io/x/y:1': {} } });
    ok({ initializeCommand: 'podman network exists agent-proxy-net || podman network create --internal agent-proxy-net' });
    ok({ initializeCommand: ['sh', '-c', 'echo hi'] });
    refused({ build: { context: '..' } }, /build\.context \.\. is outside/);
    refused({ build: { dockerfile: '../Dockerfile' } }, /build\.dockerfile \.\.\/Dockerfile is outside/);
    refused({ features: { '../feature': {} } }, /local Feature \.\.\/feature is outside/);
    refused({ dockerComposeFile: 'compose.yml' }, /dockerComposeFile/);
    refused({ initializeCommand: `sh ${join(root, 'scripts', 'setup.sh')}` }, /initializeCommand names .*setup\.sh/);
    refused({ initializeCommand: { setup: 'sh ../setup.sh' } }, /initializeCommand names \.\.\/setup\.sh/);
    symlinkSync('/etc/passwd', join(dir, 'link'));
    refused({}, /link is a symlink/);
});

test('riskSummary lists what runs on the host first, then rights, mounts and Features', () => {
    const lines = riskSummary({
        postCreateCommand: 'npm install',
        features: { 'ghcr.io/devcontainers/features/node:1': {} },
        mounts: ['type=volume,source=x,target=/y', 'type=bind,source=/home/me/.ssh,target=/ssh'],
        runArgs: ['--name', 'x', '--cap-add', 'SYS_ADMIN', '--device=/dev/fuse', '--cap-drop=all'],
        capAdd: ['NET_ADMIN'],
        privileged: true,
        initializeCommand: 'curl https://example.invalid | sh',
        customizations: { 'podman-agent-sandbox': { version: 1, seccompAllow: ['chroot'] } },
    });
    assert.deepEqual(lines[0], ['runs on your machine', 'curl https://example.invalid | sh']);
    const text = lines.map((l) => l.join(': ')).join('\n');
    for (const want of ['privileged', 'capability: NET_ADMIN', 'seccomp allows: chroot', 'runArgs: --cap-add SYS_ADMIN',
        'runArgs: --device=/dev/fuse', 'host mount: type=bind,source=/home/me/.ssh', 'Feature: ghcr.io/devcontainers/features/node:1',
        'postCreateCommand (inside): npm install']) {
        assert.ok(text.includes(want), `has ${want}:\n${text}`);
    }
    assert.ok(!text.includes('type=volume'), 'volumes are not host mounts');
    assert.ok(!text.includes('--cap-drop'), 'dropping rights is not a risk');
    assert.deepEqual(riskSummary({ image: 'x' }), [['image', 'x']]);
});

test('riskSummary leaves out what only takes rights away: keep-id, no-new-privileges, read-only project mounts', () => {
    const lines = riskSummary({
        runArgs: ['--userns=keep-id', '--security-opt=no-new-privileges', '--userns=host', '--security-opt=unmask=/proc/*'],
        mounts: [
            'type=bind,source=${localWorkspaceFolder}/.devcontainer,target=/workspace/.devcontainer,readonly',
            'type=bind,source=${localWorkspaceFolder}/data,target=/data',
            'type=bind,source=/home/me/.ssh,target=/ssh,readonly',
        ],
    });
    assert.deepEqual(lines, [
        ['runArgs', '--userns=host'],
        ['runArgs', '--security-opt=unmask=/proc/*'],
        ['host mount', 'type=bind,source=${localWorkspaceFolder}/data,target=/data'],
        ['host mount', 'type=bind,source=/home/me/.ssh,target=/ssh,readonly'],
    ], 'a writable project mount and a read-only mount from elsewhere still count');
});

test('riskSummary shows ${localEnv:…} as it will be, given the environment sandbox passes', () => {
    const config = {
        initializeCommand: 'echo ${localEnv:USER}',
        postCreateCommand: 'PAS_VERSION=${localEnv:SANDBOX_VERSION} sh x.sh; echo ${localEnv:MISSING:fallback}${localEnv:GONE}.',
    };
    assert.deepEqual(riskSummary(config, { USER: 'me', SANDBOX_VERSION: '0.7.0' }), [
        ['runs on your machine', 'echo me'],
        ['postCreateCommand (inside)', 'PAS_VERSION=0.7.0 sh x.sh; echo fallback.'],
    ]);
    assert.deepEqual(riskSummary(config)[0], ['runs on your machine', 'echo ${localEnv:USER}'], 'without ENV, as written');
    assert.equal(resolveLocalEnv('${localEnv:A}-${localEnv:B:b}', { A: 'a' }), 'a-b');
});

test('every bundled template carries the marker, so --inplace --template accepts what it writes', () => {
    for (const { id } of listTemplates()) {
        const config = JSON.parse(readFileSync(new URL(`../templates/${id}/.devcontainer/devcontainer.json`, import.meta.url), 'utf8'));
        assert.doesNotThrow(() => checkMarker(config, id), id);
    }
});

test('new --inplace refuses a plain .devcontainer (not a sandbox config) and points to the template way', { skip: noGit }, () => {
    const dir = tempDir();
    const root = project({ customizations: { vscode: {} } });
    const result = sandbox(['new', 'p', '--workspace', root, '--inplace', '--yes'], dir);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /isn't a sandbox config/);
    assert.match(result.stderr, /sandbox new --workspace PATH --template claude/);
    assert.ok(!existsSync(join(dir, 'p')), 'nothing made');
    assert.equal(hasMarker(root), false);
});

test('new --inplace: asks for trust (refused without a terminal), --yes makes it; the config that runs is a copy',
    { skip: noGit }, () => {
        const dir = tempDir();
        const root = project();
        const asked = sandbox(['new', 'p', '--workspace', root, '--inplace'], dir);
        assert.notEqual(asked.status, 0);
        assert.match(asked.stderr, /asks for:\n {2}image +docker\.io\/library\/debian:trixie-slim/);
        assert.match(asked.stderr, /not at a terminal, so not asking: review .*, then run this again with --yes/);
        assert.doesNotMatch(asked.stderr, /Show its files|diff -ruN/, 'the list, then one question; no diff against nothing');
        assert.ok(!existsSync(join(dir, 'p')));

        const made = sandbox(['new', 'p', '--workspace', root, '--inplace', '--yes'], dir);
        assert.equal(made.status, 0, made.stderr);
        const settings = JSON.parse(readFileSync(join(dir, 'p', 'sandbox.json'), 'utf8'));
        assert.equal(settings.inplace, true);
        assert.equal(settings.workspace, root);
        assert.equal(settings.configTree, configTree(root));
        assert.deepEqual(readFileSync(join(dir, 'p', 'trusted', 'Containerfile'), 'utf8'),
            readFileSync(join(root, '.devcontainer', 'Containerfile'), 'utf8'));
        const config = JSON.parse(readFileSync(join(dir, 'p', '.devcontainer', 'devcontainer.json'), 'utf8'));
        assert.equal(config.workspaceFolder, root);
        assert.ok(config.mounts.includes(`type=bind,source=${root}/.devcontainer,target=${root}/.devcontainer,readonly`),
            'the project\'s config is read-only inside');
        assert.ok(!existsSync(join(root, '.devcontainer', 'seccomp.json')), 'nothing written into the project');

        const again = sandbox(['new', 'p', '--workspace', root, '--inplace', '--yes'], dir);
        assert.notEqual(again.status, 0);
        assert.match(again.stderr, new RegExp(`${join(dir, 'p')} already exists \\(a sandbox around ${root}, made with --inplace\\)`));
        assert.match(again.stderr, /To use it: +sandbox enter p/);
        assert.match(again.stderr, new RegExp(`To make it again: +sandbox rm p \\(if it has a container\\), then rm -r ${join(dir, 'p')}`));
        assert.match(again.stderr, /To make another one: +give it another NAME/);
    });

test('a changed project config: build refuses and offers the diff; trust shows it and, with --yes, uses it',
    { skip: noGit }, () => {
        const dir = tempDir();
        const root = project();
        assert.equal(sandbox(['new', 'p', '--workspace', root, '--inplace', '--yes'], dir).status, 0);
        const trusted = configTree(root);
        const file = join(root, '.devcontainer', 'devcontainer.json');
        const config = JSON.parse(readFileSync(file, 'utf8'));
        writeFileSync(file, JSON.stringify({ ...config, runArgs: ['--privileged'] }, null, 2));
        writeFileSync(join(root, '.devcontainer', 'setup.sh'), 'echo from-a-new-file\n');

        const build = sandbox(['build', 'p'], dir);
        assert.notEqual(build.status, 0);
        assert.match(build.stderr, new RegExp(`the project's config changed since you trusted it \\(${trusted.slice(0, 7)} -> `));
        assert.match(build.stderr, new RegExp(`See what changed: +diff -ruN ${join(dir, 'p', 'trusted')} ${root}/\\.devcontainer`));
        assert.match(build.stderr, /'sandbox trust p' to review and use the new config, or restore/);

        const asked = sandbox(['trust', 'p'], dir);
        assert.notEqual(asked.status, 0);
        assert.match(asked.stderr, /\+ {2}"runArgs": \[/, 'the diff is shown');
        assert.match(asked.stderr, /^\+echo from-a-new-file$/m, 'a new file is shown in full, not as "Only in"');
        assert.match(asked.stderr, /not at a terminal/);
        assert.equal(JSON.parse(readFileSync(join(dir, 'p', 'sandbox.json'), 'utf8')).configTree, trusted, 'still the old one');

        const ok = sandbox(['trust', 'p', '--yes'], dir);
        assert.equal(ok.status, 0, ok.stderr);
        assert.equal(JSON.parse(readFileSync(join(dir, 'p', 'sandbox.json'), 'utf8')).configTree, configTree(root));
        assert.deepEqual(JSON.parse(readFileSync(join(dir, 'p', '.devcontainer', 'devcontainer.json'), 'utf8')).runArgs,
            ['--privileged']);
        assert.match(sandbox(['trust', 'p'], dir).stdout, /unchanged/);

        rmSync(join(root, '.devcontainer'), { recursive: true });
        const gone = sandbox(['build', 'p'], dir);
        assert.match(gone.stderr, /\.devcontainer is gone/);
    });

test('new --inplace --template writes the template into the project, with the marker and without seccomp.json',
    { skip: noGit }, () => {
        const dir = tempDir();
        const root = tempDir();
        const made = sandbox(['new', 'c', '--workspace', root, '--inplace', '--template', 'claude-containers'], dir);
        assert.equal(made.status, 0, made.stderr);
        assert.match(made.stdout, /wrote .*\.devcontainer from template 'claude-containers': review it, and commit it/);
        const config = JSON.parse(readFileSync(join(root, '.devcontainer', 'devcontainer.json'), 'utf8'));
        assert.deepEqual(config.customizations['podman-agent-sandbox'].seccompAllow, ['sethostname', 'setdomainname']);
        assert.ok(!existsSync(join(root, '.devcontainer', 'seccomp.json')), 'the profile is generated, not committed');
        assert.ok(!config.runArgs.some((arg) => arg.startsWith('--security-opt=seccomp=')), 'so is the runArg naming it');
        const running = JSON.parse(readFileSync(join(dir, 'c', '.devcontainer', 'devcontainer.json'), 'utf8'));
        assert.ok(running.runArgs.includes('--security-opt=seccomp=${localWorkspaceFolder}/.devcontainer/seccomp.json'),
            'the config that runs has both');
        assert.equal(config.workspaceFolder, '/workspace', 'the committed config has no paths of this machine');
        // The config that runs has the generated profile.
        const profile = JSON.parse(readFileSync(join(dir, 'c', '.devcontainer', 'seccomp.json'), 'utf8'));
        assert.ok(JSON.stringify(profile).includes('sethostname'));

        const over = sandbox(['new', 'c2', '--workspace', root, '--inplace', '--template', 'claude'], dir);
        assert.match(over.stderr, /already exists, and --template would write over it/);
        assert.doesNotMatch(made.stderr, /secrets/, 'nothing to warn about');
        const proxy = tempDir();
        writeFileSync(join(proxy, '.env'), 'TOKEN=x');
        const client = sandbox(['new', 'pc', '--workspace', proxy, '--inplace', '--template', 'proxy-client'], dir);
        assert.equal(client.status, 0, client.stderr);
        assert.match(client.stdout, /not written into the project .*: CLAUDE\.md/);
        assert.match(client.stderr, /warning: pc can read files whose names suggest secrets:\n {2}\.env\n/);
    });

test('new --inplace refuses --hide of the project\'s .devcontainer; new without --template hints at --inplace',
    { skip: noGit }, () => {
        const dir = tempDir();
        const root = project();
        const hidden = sandbox(['new', 'p', '--workspace', root, '--inplace', '--yes', '--hide', '.devcontainer'], dir);
        assert.match(hidden.stderr, /--hide \.devcontainer can't hide it/);
        const hint = sandbox(['new', '--workspace', root], dir);
        assert.match(hint.stderr, /This project has its own sandbox config: sandbox new --workspace .* --inplace/);
        const plain = sandbox(['new', '--workspace', project({ customizations: {} })], dir);
        assert.doesNotMatch(plain.stderr, /own sandbox config/);
        assert.match(sandbox(['new', 'x', '--inplace'], dir).stderr, /--inplace needs --workspace/);
        assert.match(sandbox(['trust', 'nothing-here-xyz'], dir).stderr, /no container or dev container config/);
    });
