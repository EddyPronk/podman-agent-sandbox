import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { lockPath, lockSandbox } from '../src/lock.js';
import { isInside } from '../src/workspace.js';

const LOCK = new URL('../src/lock.js', import.meta.url).href;

/**
 * A child process that takes NAME's lock (in SANDBOX_DIR), says "held", and keeps it until killed; with
 * REMOVE_AFTER (ms), it releases it then, deleting the file, as a command that found nothing does.
 */
function holder(dir, name, { removeAfter = null } = {}) {
    const child = spawn(process.execPath, ['--input-type=module', '-e',
        `import { lockSandbox } from ${JSON.stringify(LOCK)};
         const release = lockSandbox(${JSON.stringify(name)});
         console.log('held');
         ${removeAfter === null ? '' : `setTimeout(() => release({ remove: true }), ${removeAfter});`}
         setInterval(() => {}, 1000);`],
    { env: { ...process.env, SANDBOX_DIR: dir }, stdio: ['ignore', 'pipe', 'inherit'] });
    const held = new Promise((resolve, reject) => {
        child.stdout.on('data', (data) => data.toString().includes('held') && resolve());
        child.on('exit', (code) => reject(new Error(`holder exited (${code})`)));
    });
    return { child, held };
}

const exited = (child) => new Promise((resolve) => child.on('exit', resolve));

test('the lock: a second command waits while the first holds it, and gets it once it is gone', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sandbox-test-'));
    const env = { SANDBOX_DIR: dir };
    const { child, held } = holder(dir, 'box');
    await held;
    const waited = [];
    // The holder is killed while we wait: the OS drops its lock, so a killed command frees it too.
    // By another process: lockSandbox blocks this one while it waits.
    const done = exited(child);
    const start = Date.now();
    spawn('sh', ['-c', `sleep 0.5; kill -9 ${child.pid}`], { stdio: 'ignore' });
    const release = lockSandbox('box', { env, waiting: (name) => waited.push(name) });
    const took = Date.now() - start;
    await done;
    assert.deepEqual(waited, ['box'], 'it said it was waiting');
    assert.ok(took >= 400, `it got the lock only after the holder was gone (${took} ms)`);
    release();
    release();   // a second release does nothing
});

test('the lock: free means no wait; another sandbox\'s lock doesn\'t count', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sandbox-test-'));
    const env = { SANDBOX_DIR: dir };
    const { child, held } = holder(dir, 'other');
    await held;
    const waited = [];
    const release = lockSandbox('box', { env, waiting: (name) => waited.push(name) });
    assert.deepEqual(waited, []);
    release();
    // Released: taken again at once.
    lockSandbox('box', { env, waiting: (name) => waited.push(name) })();
    assert.deepEqual(waited, []);
    child.kill('SIGKILL');
    await exited(child);
});

test('the lock: release({ remove }) deletes the file; a command that waited locks the file at the path', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sandbox-test-'));
    const env = { SANDBOX_DIR: dir };
    lockSandbox('gone', { env })({ remove: true });
    assert.ok(!existsSync(lockPath('gone', env)), 'removed');

    // The holder deletes the file while we wait on it: we must not end up holding the deleted file.
    const { child, held } = holder(dir, 'box', { removeAfter: 500 });
    await held;
    const waited = [];
    const release = lockSandbox('box', { env, waiting: (name) => waited.push(name) });
    assert.deepEqual(waited, ['box'], 'said once that it waits');
    assert.ok(existsSync(lockPath('box', env)), 'a new file at the path');
    const other = spawnSync('flock', ['--nonblock', lockPath('box', env), 'true']);
    assert.equal(other.status, 1, 'and it is that file that is locked: a third command can\'t take it');
    release();
    assert.equal(spawnSync('flock', ['--nonblock', lockPath('box', env), 'true']).status, 0);
    child.kill('SIGKILL');
    await exited(child);
});

test('the lock: without flock, refuse and name util-linux', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sandbox-test-'));
    const path = process.env.PATH;
    process.env.PATH = join(dir, 'no-such-bin');
    try {
        assert.throws(() => lockSandbox('box', { env: { SANDBOX_DIR: dir } }), /flock not found on PATH: .*util-linux/);
    } finally {
        process.env.PATH = path;
    }
});

test('the lock is outside the sandbox\'s config folder, which may be its workspace, mounted inside', () => {
    const env = { SANDBOX_DIR: '/home/u/sandboxes' };
    assert.equal(lockPath('box', env), '/home/u/sandboxes/.locks/box');
    assert.ok(!isInside(lockPath('box', env), '/home/u/sandboxes/box'));
});
