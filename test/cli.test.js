import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { helpText } from '../dist/cli.js';
import { table, writableConfig } from '../dist/inspect.js';
import { checkName, childEnv, cliPath, folderOf, sandboxDir, sandboxReason, unlabelledHint } from '../dist/devcontainer.js';

test('sandboxDir defaults to ~/sandboxes', () => {
    assert.equal(sandboxDir({}), join(homedir(), 'sandboxes'));
    assert.equal(sandboxDir({ SANDBOX_DIR: '/x' }), '/x');
});

test('checkName rejects path tricks', () => {
    assert.equal(checkName('04-claude'), '04-claude');
    for (const bad of ['', '../x', 'a/b', '.hidden', '-x']) assert.throws(() => checkName(bad));
});

test('folderOf prefers the container label, then $SANDBOX_DIR/NAME', () => {
    const root = mkdtempSync(join(tmpdir(), 'sandbox-test-'));
    for (const name of ['box', 'elsewhere']) {
        mkdirSync(join(root, name, '.devcontainer'), { recursive: true });
        writeFileSync(join(root, name, '.devcontainer', 'devcontainer.json'), '{}');
    }
    const env = { SANDBOX_DIR: root };
    assert.equal(folderOf('box', { lookup: () => '', env }), join(root, 'box'));
    assert.equal(folderOf('box', { lookup: () => join(root, 'elsewhere'), env }), join(root, 'elsewhere'));
    assert.throws(() => folderOf('missing', { lookup: () => '', env }), /no container or dev container config/);
});

test('sandboxReason: only the label; unlabelledHint: what the config folder suggests', () => {
    // A config folder in $SANDBOX_DIR only says where a config lives: VS Code made hopeful_hugle there
    // (lab 09), so stop and rm must not act on it without --force.
    assert.equal(sandboxReason({ label: '0.6.0' }), 'label podman-agent-sandbox=0.6.0');
    assert.equal(sandboxReason({}), '');
    const files = new Set(['/sb/old/.devcontainer/devcontainer.json', '/elsewhere/ws/.devcontainer/devcontainer.json',
        '/elsewhere/ws/sandbox.json', '/src/app/.devcontainer/devcontainer.json']);
    const opts = { env: { SANDBOX_DIR: '/sb/' }, exists: (p) => files.has(p) };
    assert.equal(unlabelledHint({ folder: '/sb/old' }, opts), 'its config folder is in /sb/');
    assert.equal(unlabelledHint({ folder: '/elsewhere/ws' }, opts), 'its config folder has a sandbox.json');
    // A dev container VS Code opened from a project folder, one made in a volume, a folder gone.
    assert.equal(unlabelledHint({ folder: '/src/app' }, opts), '');
    assert.equal(unlabelledHint({}, opts), '');
    assert.equal(unlabelledHint({ folder: '/sb/gone' }, opts), '');
});

test('cliPath points at the pinned Dev Containers CLI', () => {
    assert.match(cliPath(), /node_modules\/@devcontainers\/cli\/devcontainer\.js$/);
});

test('table pads all but the last column', () => {
    assert.equal(table([['A', 'BB', 'C'], ['aaa', 'b', 'c']]), 'A    BB  C\naaa  b   c');
});

test('--version prints the package and Dev Containers CLI versions', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    for (const flag of ['--version', '-V', 'version']) {
        const result = spawnSync(process.execPath, [fileURLToPath(new URL('../bin/sandbox.js', import.meta.url)), flag],
            { encoding: 'utf8' });
        assert.equal(result.status, 0);
        assert.equal(result.stdout,
            `sandbox ${pkg.version} (@devcontainers/cli ${pkg.dependencies['@devcontainers/cli']})\n`);
    }
});

test('childEnv sets USER from the user database when it is missing (containers, cron, systemd)', () => {
    assert.equal(childEnv({}).USER, userInfo().username);
    assert.equal(childEnv({ USER: '' }).USER, userInfo().username);
    assert.equal(childEnv({ USER: 'someone' }).USER, 'someone', 'an existing USER is kept');
});

test('childEnv sets the numeric IDs for containerUser', () => {
    const env = childEnv({ PATH: '/bin' });
    assert.equal(env.SANDBOX_UID, String(process.getuid()));
    assert.equal(env.SANDBOX_GID, String(process.getgid()));
    assert.equal(env.PATH, '/bin', 'the rest of the environment is passed on');
});

test('childEnv passes this package version on, for the sandbox inside a sandbox', () => {
    const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    assert.equal(childEnv({}).SANDBOX_VERSION, version);
});

test('helpText: the template HELP with the sandbox name and folder filled in', () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'sandbox-test-')), 'proxy');
    mkdirSync(join(dir, '.devcontainer'), { recursive: true });
    writeFileSync(join(dir, '.devcontainer', 'HELP'),
        'sandbox exec ${localWorkspaceFolderBasename} approve\nedit ${localWorkspaceFolder}/allowlist.txt\n');
    assert.equal(helpText('proxy', dir), `sandbox exec proxy approve\nedit ${dir}/allowlist.txt\n`);
});

test('helpText: without a HELP, what every sandbox has', () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'sandbox-test-')), 'work');
    mkdirSync(join(dir, '.devcontainer'), { recursive: true });
    const text = helpText('work', dir);
    assert.match(text, /^work: its template has no help of its own/);
    assert.match(text, /sandbox exec work COMMAND +run a command there/);
    assert.match(text, new RegExp(`Its config is in ${join(dir, '.devcontainer')}\\.\\n$`));
});

test('sandbox exec: usage errors before anything runs', () => {
    const run = (...args) => spawnSync(process.execPath,
        [fileURLToPath(new URL('../bin/sandbox.js', import.meta.url)), 'exec', ...args], { encoding: 'utf8' });
    for (const args of [[], ['box'], ['box', '--'], ['--', 'pwd']]) {
        const result = run(...args);
        assert.equal(result.status, 1, `exec ${args.join(' ')}`);
        assert.match(result.stderr, /usage: sandbox exec NAME \[--\] COMMAND/);
    }
});

test('writableConfig: the sandbox .devcontainer is writable unless a read-only mount covers it', () => {
    const folder = '/home/u/sandboxes/box';
    const exists = (path) => path === `${folder}/.devcontainer`;            // no sandbox.json: not --workspace
    const bind = (Source, Destination, RW) => ({ Type: 'bind', Source, Destination, RW });
    const old = { Mounts: [bind(folder, '/workspace', true)] };
    assert.equal(writableConfig(old, folder, exists), '/workspace/.devcontainer');
    const fixed = { Mounts: [bind(folder, '/workspace', true), bind(`${folder}/.devcontainer`, '/workspace/.devcontainer', false)] };
    assert.equal(writableConfig(fixed, folder, exists), null);
    const workspace = (path) => path === `${folder}/.devcontainer` || path === `${folder}/sandbox.json`;
    assert.equal(writableConfig(old, folder, workspace), null, '--workspace: the config is outside the project');
    assert.equal(writableConfig(old, folder, () => false), null, 'no .devcontainer in the folder');
    assert.equal(writableConfig({ Mounts: [bind(folder, '/workspace', false)] }, folder, exists), null, 'workspace read-only');
    assert.equal(writableConfig(old, undefined, exists), null, 'no folder label');
});
