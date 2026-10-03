import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { table } from '../src/cli.js';
import { checkName, cliPath, folderOf, sandboxDir } from '../src/devcontainer.js';

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
