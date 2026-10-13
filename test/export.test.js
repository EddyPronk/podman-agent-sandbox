import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { addedMount } from '../src/export.js';
import { configTree } from '../src/inplace.js';

const SANDBOX = fileURLToPath(new URL('../bin/sandbox.js', import.meta.url));
const noGit = spawnSync('git', ['--version']).status !== 0;

function tempDir() {
    return realpathSync(mkdtempSync(join(tmpdir(), 'sandbox-test-')));
}

/** A project with a (fake) git repo, a secret to hide and notes to make read-only. */
function project() {
    const root = tempDir();
    mkdirSync(join(root, '.git', 'hooks'), { recursive: true });
    writeFileSync(join(root, '.git', 'config'), '');
    writeFileSync(join(root, '.env'), 'TOKEN=x');
    mkdirSync(join(root, 'docs'));
    return root;
}

function sandbox(args, dir) {
    return spawnSync(process.execPath, [SANDBOX, ...args],
        { encoding: 'utf8', env: { ...process.env, SANDBOX_DIR: dir }, stdio: ['ignore', 'pipe', 'pipe'] });
}

const json = (path) => JSON.parse(readFileSync(path, 'utf8'));

test('addedMount knows the mounts --workspace adds, and nothing else', () => {
    const ws = '/p';
    assert.ok(addedMount('type=bind,source=/p/.git/hooks,target=/p/.git/hooks,readonly', ws));
    assert.ok(addedMount('type=tmpfs,target=/p/secrets,notmpcopyup', ws));
    assert.ok(addedMount('type=bind,source=/dev/null,target=/p/.env,readonly', ws));
    assert.ok(!addedMount('type=bind,source=/elsewhere,target=/elsewhere,readonly', ws), 'outside the workspace');
    assert.ok(!addedMount('type=bind,source=/p/data,target=/data,readonly', ws), 'a mount of the user\'s own');
    assert.ok(!addedMount('type=volume,source=x-home,target=/home/me,U=true', ws));
    assert.ok(!addedMount('type=bind,source=/p,target=/p,readonly', ws), 'the workspace itself');
    assert.ok(!addedMount({ type: 'bind', source: '/p/x', target: '/p/x' }, ws));
});

test('export writes the config with the user\'s edits and without this machine\'s settings, then uses it',
    { skip: noGit }, () => {
        const dir = tempDir();
        const root = project();
        const made = sandbox(['new', 'ex', '--template', 'claude-containers', '--workspace', root,
            '--hide', '.env', '--readonly', 'docs'], dir);
        assert.equal(made.status, 0, made.stderr);
        // The user's own edit in the sandbox's config, as for agent-mitm-proxy (Python, uv).
        const file = join(dir, 'ex', '.devcontainer', 'devcontainer.json');
        const edited = json(file);
        edited.containerEnv.UV_PROJECT_ENVIRONMENT = '/home/${localEnv:USER}/.venv-ex';
        writeFileSync(file, JSON.stringify(edited, null, 2));
        writeFileSync(join(dir, 'ex', '.devcontainer', 'Containerfile'),
            `${readFileSync(join(dir, 'ex', '.devcontainer', 'Containerfile'), 'utf8')}\nCOPY --from=ghcr.io/astral-sh/uv:0.11.8 /uv /usr/local/bin/\n`);

        const exported = sandbox(['export', 'ex'], dir);
        assert.equal(exported.status, 0, exported.stderr);
        assert.match(exported.stdout, /left out: the workspace at .* \(back to \/workspace\)/);
        assert.match(exported.stdout, /left out: mount type=tmpfs|left out: mount type=bind,source=\/dev\/null,target=.*\.env/);
        assert.match(exported.stdout, /left out: seccomp\.json/);
        assert.match(exported.stdout, /sandbox new --workspace \. --inplace/);
        assert.doesNotMatch(exported.stderr, /still names paths of this machine/);

        const config = json(join(root, '.devcontainer', 'devcontainer.json'));
        const text = JSON.stringify(config);
        assert.ok(!text.includes(root), 'no path of this machine');
        assert.equal(config.workspaceFolder, '/workspace');
        assert.equal(config.containerEnv.UV_PROJECT_ENVIRONMENT, '/home/${localEnv:USER}/.venv-ex', 'the edit is kept');
        assert.match(readFileSync(join(root, '.devcontainer', 'Containerfile'), 'utf8'), /astral-sh\/uv/, 'so is this one');
        assert.ok(config.mounts.includes('type=bind,source=${localWorkspaceFolder}/.devcontainer,target=/workspace/.devcontainer,readonly'));
        assert.deepEqual(config.customizations['podman-agent-sandbox'],
            { version: 1, policies: [], seccompAllow: ['sethostname', 'setdomainname'] });
        assert.ok(!existsSync(join(root, '.devcontainer', 'seccomp.json')), 'generated, not committed');
        assert.ok(!config.runArgs.some((arg) => arg.startsWith('--security-opt=seccomp=')),
            'nor the runArg naming it: the Dev Containers CLI on its own can start the committed config');

        // The sandbox now uses it, as with --inplace.
        const settings = json(join(dir, 'ex', 'sandbox.json'));
        assert.equal(settings.inplace, true);
        assert.equal(settings.configTree, configTree(root));
        assert.deepEqual(settings.hide, ['.env'], 'the user\'s choices stay in sandbox.json');
        const effective = json(file);
        assert.equal(effective.workspaceFolder, root, 'the config that runs has the workspace again');
        assert.ok(effective.mounts.includes(`type=bind,source=/dev/null,target=${root}/.env,readonly`));
        assert.ok(effective.mounts.includes(`type=bind,source=${root}/.devcontainer,target=${root}/.devcontainer,readonly`));
        assert.ok(existsSync(join(dir, 'ex', '.devcontainer', 'seccomp.json')), 'and its profile');
        assert.ok(effective.runArgs.includes('--security-opt=seccomp=${localWorkspaceFolder}/.devcontainer/seccomp.json'),
            'with the runArg naming it');
        assert.match(sandbox(['trust', 'ex'], dir).stdout, /unchanged/);

        const twice = sandbox(['export', 'ex'], dir);
        assert.match(twice.stderr, /already uses its project's config/);
    });

test('export of a sandbox from before 0.7.0: seccompAllow comes from the generated profile', { skip: noGit }, () => {
    const dir = tempDir();
    const root = project();
    assert.equal(sandbox(['new', 'old', '--template', 'claude-containers', '--workspace', root], dir).status, 0);
    const file = join(dir, 'old', '.devcontainer', 'devcontainer.json');
    const config = json(file);
    delete config.customizations;   // as 0.6.0 made it: no marker, seccompAllow in the template's metadata
    writeFileSync(file, JSON.stringify(config, null, 2));
    const exported = sandbox(['export', 'old'], dir);
    assert.equal(exported.status, 0, exported.stderr);
    assert.deepEqual(json(join(root, '.devcontainer', 'devcontainer.json')).customizations['podman-agent-sandbox'],
        { version: 1, policies: [], seccompAllow: ['sethostname', 'setdomainname'] });
});

test('export warns about paths of this machine it can\'t take out', { skip: noGit }, () => {
    const dir = tempDir();
    const root = project();
    assert.equal(sandbox(['new', 'p', '--template', 'claude', '--workspace', root], dir).status, 0);
    const file = join(dir, 'p', '.devcontainer', 'devcontainer.json');
    const config = json(file);
    config.mounts.push(`type=bind,source=${root}/data,target=/data`);
    writeFileSync(file, JSON.stringify(config, null, 2));
    const exported = sandbox(['export', 'p'], dir);
    assert.equal(exported.status, 0, exported.stderr);
    assert.match(exported.stderr, new RegExp(`still names paths of this machine.*\\n.*${root}/data`));
});

test('export refuses a sandbox without --workspace, and a project that has a .devcontainer', { skip: noGit }, () => {
    const dir = tempDir();
    assert.equal(sandbox(['new', 'plain', '--template', 'claude'], dir).status, 0);
    assert.match(sandbox(['export', 'plain'], dir).stderr, /wasn't made with --workspace: there's no project/);
    const root = project();
    assert.equal(sandbox(['new', 'w', '--template', 'claude', '--workspace', root], dir).status, 0);
    mkdirSync(join(root, '.devcontainer'));
    assert.match(sandbox(['export', 'w'], dir).stderr, /\.devcontainer already exists; export doesn't write over it/);
});
