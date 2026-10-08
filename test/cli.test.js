import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { table } from '../src/cli.js';
import { checkName, childEnv, cliPath, folderOf, sandboxDir } from '../src/devcontainer.js';

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
