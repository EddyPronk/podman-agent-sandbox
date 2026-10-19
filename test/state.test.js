import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { readRecord, recordPath, removeRecord, writeRecord } from '../src/state.js';
import { isInside } from '../src/workspace.js';

/** A $SANDBOX_DIR with a config folder for NAME. */
function sandboxes(name) {
    const dir = mkdtempSync(join(tmpdir(), 'sandbox-test-'));
    mkdirSync(join(dir, name, '.devcontainer'), { recursive: true });
    writeFileSync(join(dir, name, '.devcontainer', 'devcontainer.json'), '{}\n');
    return { env: { SANDBOX_DIR: dir }, folder: join(dir, name) };
}

test('records: written, read back and removed; outside the sandbox\'s own folder', () => {
    const { env, folder } = sandboxes('box');
    assert.equal(readRecord('box', { env }), null, 'none yet');
    writeRecord('box', { kind: 'vm', folder }, env);
    assert.deepEqual(readRecord('box', { env }), { kind: 'vm', folder });
    assert.equal(recordPath('box', env), join(env.SANDBOX_DIR, '.state', 'box.json'));
    assert.ok(!isInside(recordPath('box', env), folder), 'not in the folder, which may be the workspace, mounted inside');
    removeRecord('box', env);
    assert.equal(readRecord('box', { env }), null);
    removeRecord('box', env);   // nothing to remove: no error
});

test('records: one whose folder is gone, or that can\'t be read, counts as gone and is removed', () => {
    const { env, folder } = sandboxes('box');
    writeRecord('box', { kind: 'vm', folder: join(folder, '..', 'deleted') }, env);
    assert.equal(readRecord('box', { env }), null);
    assert.ok(!existsSync(recordPath('box', env)), 'removed');
    for (const text of ['not json', JSON.stringify({ kind: 'lxc', folder }), JSON.stringify({ kind: 'vm' })]) {
        writeFileSync(recordPath('box', env), text);
        assert.equal(readRecord('box', { env }), null, text);
        assert.ok(!existsSync(recordPath('box', env)), `removed: ${text}`);
    }
});
