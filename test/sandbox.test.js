import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { enterPlan } from '../src/sandbox.js';

const SANDBOX = fileURLToPath(new URL('../bin/sandbox.js', import.meta.url));
const FAKE = fileURLToPath(new URL('./fake-podman/', import.meta.url));

/** An EnterState: C and V each absent or a podman state; TAKEN: NAME-vm is someone else's. */
function state({ c = 'absent', v = 'absent', taken = false } = {}) {
    const presence = (s) => ({ exists: s !== 'absent', active: !['absent', 'exited', 'created', 'stopped'].includes(s) });
    return { name: 'x', container: { ...presence(c), created: '2026-10-01 12:00' }, vm: presence(v), nameTaken: taken };
}

test('enterPlan: what sandbox enter [--vm [--from-existing]] does, for each state', () => {
    const open = (target) => ({ action: 'open', target });
    const make = (createFirst) => ({ action: 'makeVm', createFirst });
    const no = { allowed: false, reason: 'krun not found on PATH' };
    const policy = { allowed: false, reason: 'this config\'s policies include no-vm' };
    const table = [
        // [state, options, expected: an action or a pattern for refuse's why]
        [{}, {}, open('container')],
        [{ c: 'running' }, {}, open('container')],
        [{ c: 'exited' }, {}, open('container')],
        [{ v: 'exited' }, {}, /x is a VM: 'sandbox enter --vm x' connects to it; 'sandbox rm x' makes it a container again/],
        [{ c: 'exited', v: 'running' }, {}, /x is a VM/],
        // --vm: the refusals that come first, on every path
        [{ v: 'running' }, { vm: true, host: no }, /krun not found/],
        [{ v: 'running' }, { vm: true, policy }, /x can't run as a VM: this config's policies include no-vm/],
        // 1. the VM is active: attach (also when the container is active too)
        [{ c: 'exited', v: 'running' }, { vm: true }, open('vm')],
        [{ c: 'running', v: 'running' }, { vm: true }, open('vm')],
        [{ v: 'paused' }, { vm: true }, open('vm')],
        [{ v: 'stopping' }, { vm: true }, open('vm')],
        // 2. the normal container is active: refuse
        [{ c: 'running' }, { vm: true }, /x runs as a normal container, not a VM: 'sandbox stop x' first/],
        [{ c: 'paused', v: 'exited' }, { vm: true }, /runs as a normal container/],
        // 3. the VM exists, inactive: start it (also one left created by a failed run)
        [{ c: 'exited', v: 'exited' }, { vm: true }, { action: 'start' }],
        [{ v: 'created' }, { vm: true }, { action: 'start' }],
        [{ v: 'exited' }, { vm: true, fromExisting: true }, { action: 'start' }],
        // 4. no VM, a container this command didn't make: refuse, unless --from-existing
        [{ c: 'exited' }, { vm: true }, /x already exists as a container, made 2026-10-01 12:00\. .*sandbox rm x .*--from-existing x/s],
        [{ c: 'created' }, { vm: true }, /already exists as a container/],
        [{ c: 'exited' }, { vm: true, fromExisting: true }, make(false)],
        // 5. nothing: make the container, then the VM
        [{}, { vm: true }, make(true)],
        [{}, { vm: true, fromExisting: true }, /x has no container to make the VM from: leave out --from-existing/],
        // a foreign x-vm, without the label: only when a VM would be made
        [{ taken: true }, { vm: true }, /the name x-vm is taken by another container/],
        [{ c: 'exited', taken: true }, { vm: true, fromExisting: true }, /the name x-vm is taken/],
        [{ c: 'running', taken: true }, { vm: true }, /runs as a normal container/],
        [{ taken: true }, {}, open('container')],
    ];
    for (const [s, options, expected] of table) {
        const plan = enterPlan(state(s), options);
        const what = `${JSON.stringify(s)} ${JSON.stringify(options)}`;
        if (expected instanceof RegExp) {
            assert.equal(plan.action, 'refuse', what);
            assert.match(plan.why, expected, what);
        } else {
            assert.deepEqual(plan, expected, what);
        }
    }
});

/** A container as podman inspect shows it, as much as sandbox reads. */
function container(name, status, { labels = {}, volumes = [] } = {}) {
    return {
        Id: `${name.replace(/[^a-z0-9]/g, '')}${'0'.repeat(12)}`, Name: name, Created: '2026-10-01T10:00:00Z', Image: 'img', ImageName: 'vsc-img',
        State: { Status: status },
        Config: { CreateCommand: ['podman', 'run', '--name', name, 'vsc-img'], Labels: labels },
        Mounts: volumes.map((v) => ({ Type: 'volume', Name: v, Source: `/v/${v}`, Destination: '/home/user', RW: true })),
        NetworkSettings: { Networks: {} },
    };
}
const sandbox = (name, status, options = {}) => container(name, status,
    { ...options, labels: { 'podman-agent-sandbox': '0.8.0', ...options.labels } });
const vmOf = (of, status, options = {}) => container(`${of}-vm`, status,
    { ...options, labels: { 'podman-agent-sandbox.vm-of': of, 'podman-agent-sandbox.vm-folder': `/s/${of}`, ...options.labels } });

/** Run sandbox ARGS against the fake podman with CONTAINERS: { status, stdout, stderr, calls, containers }. */
function run(containers, ...args) {
    const dir = mkdtempSync(join(tmpdir(), 'sandbox-test-'));
    const stateFile = join(dir, 'state.json');
    const log = join(dir, 'podman.log');
    writeFileSync(stateFile, JSON.stringify({ containers }));
    writeFileSync(log, '');
    mkdirSync(join(dir, 'sandboxes'));
    const result = spawnSync(process.execPath, [SANDBOX, ...args], {
        encoding: 'utf8',
        env: { ...process.env, PATH: `${FAKE}:${process.env.PATH}`, SANDBOX_DIR: join(dir, 'sandboxes'), FAKE_PODMAN_STATE: stateFile, FAKE_PODMAN_LOG: log },
    });
    const calls = readFileSync(log, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
    return { ...result, calls, containers: JSON.parse(readFileSync(stateFile, 'utf8')).containers };
}
const names = (containers) => containers.map((c) => `${c.Name}:${c.State.Status}`).sort();
const changes = (calls) => calls.filter(([cmd]) => ['stop', 'start', 'rm', 'run', 'attach'].includes(cmd));

test('rm x and stop x leave a sandbox called x-vm alone (R1: the VM is found by its label, not its name)', () => {
    const both = () => [sandbox('x', 'running', { volumes: ['x-home'] }), sandbox('x-vm', 'running', { volumes: ['x-vm-home'] })];
    const stop = run(both(), 'stop', 'x');
    assert.equal(stop.status, 0, stop.stderr);
    assert.deepEqual(names(stop.containers), ['x-vm:running', 'x:exited']);
    assert.deepEqual(changes(stop.calls), [['stop', 'x']]);
    const rm = run(both(), 'rm', 'x');
    assert.equal(rm.status, 0, rm.stderr);
    assert.deepEqual(names(rm.containers), ['x-vm:running']);
    assert.match(rm.stdout, /^removed x\nkept volume x-home/);
    assert.doesNotMatch(rm.stdout, /x-vm/);
});

test('x\'s VM is no sandbox x-vm: rm, stop (also with --force), enter and exec on x-vm refuse (R1)', () => {
    const state = () => [sandbox('x', 'exited'), vmOf('x', 'running')];
    for (const args of [['rm', 'x-vm'], ['rm', '--force', 'x-vm'], ['stop', '--force', 'x-vm'], ['enter', 'x-vm'], ['exec', 'x-vm', 'true'],
        ['build', 'x-vm']]) {
        const result = run(state(), ...args);
        assert.equal(result.status, 1, args.join(' '));
        assert.match(result.stderr, /x-vm is the VM of x, not a sandbox: use sandbox stop, rm or enter --vm on x/, args.join(' '));
        assert.deepEqual(changes(result.calls), [], args.join(' '));
    }
    const inspect = run(state(), 'inspect', 'x-vm');
    assert.match(inspect.stdout, /^# x-vm is the VM of x .*see sandbox inspect x/);
});

test('stop: the VM at once (--time 0, by ID), the container as before; nothing active is said', () => {
    const vm = vmOf('x', 'running');
    const result = run([sandbox('x', 'exited'), vm], 'stop', 'x');
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, 'stopped x\'s VM\n');
    assert.deepEqual(changes(result.calls), [['stop', '--time', '0', vm.Id]]);

    const plain = run([sandbox('x', 'running')], 'stop', 'x');
    assert.deepEqual(changes(plain.calls), [['stop', 'x']], 'a container: no --time 0');

    const idle = run([sandbox('x', 'exited'), vmOf('x', 'exited')], 'stop', 'x');
    assert.equal(idle.status, 0);
    assert.equal(idle.stdout, 'x isn\'t running: nothing to stop\n');
    assert.deepEqual(changes(idle.calls), []);

    const none = run([], 'stop', 'x');
    assert.equal(none.status, 1);
    assert.match(none.stderr, /x has no container or VM to stop/);
});

test('rm: the VM and the container, the kept volumes listed once; also when only the VM is left', () => {
    const vm = vmOf('x', 'exited', { volumes: ['x-home'] });
    const both = run([sandbox('x', 'exited', { volumes: ['x-home'] }), vm], 'rm', 'x');
    assert.equal(both.status, 0, both.stderr);
    assert.deepEqual(both.containers, []);
    assert.deepEqual(changes(both.calls), [['rm', '-f', vm.Id], ['rm', '-f', 'x']]);
    assert.equal(both.stdout.match(/kept volume x-home/g).length, 1);
    assert.match(both.stdout, /^removed x's VM\nremoved x\n/);

    const only = run([vmOf('x', 'running', { volumes: ['x-home'] })], 'rm', 'x');
    assert.equal(only.status, 0, only.stderr);
    assert.deepEqual(only.containers, []);
    assert.match(only.stdout, /^removed x's VM\nkept volume x-home/);
});

test('enter and exec refuse for a VM sandbox, running and stopped, before starting anything', () => {
    for (const status of ['running', 'exited']) {
        const enter = run([sandbox('x', 'exited'), vmOf('x', status)], 'enter', 'x');
        assert.equal(enter.status, 1, status);
        assert.match(enter.stderr, /x is a VM: 'sandbox enter --vm x' connects to it; 'sandbox rm x' makes it a container again/);
        assert.deepEqual(changes(enter.calls), []);
        const exec = run([sandbox('x', 'exited'), vmOf('x', status)], 'exec', 'x', 'true');
        assert.equal(exec.status, 1, status);
        assert.match(exec.stderr, /x is a VM; exec can't run commands in it\. Use 'sandbox enter --vm x', or 'sandbox rm x'/);
        assert.deepEqual(changes(exec.calls), []);
    }
});

test('enter --from-existing needs --vm', () => {
    const result = run([], 'enter', '--from-existing', 'x');
    assert.equal(result.status, 1);
    assert.match(result.stderr, /--from-existing goes with --vm/);
});

test('inspect and list show the VM next to its sandbox', () => {
    const inspect = run([sandbox('x', 'exited'), vmOf('x', 'exited')], 'inspect', 'x');
    assert.equal(inspect.status, 0, inspect.stderr);
    assert.match(inspect.stdout, /^# x is a sandbox/);
    assert.match(inspect.stdout, /# x's VM: x-vm, exited, made .* to make it again: sandbox rm x, then sandbox enter --vm x\n$/);

    const local = (c, folder) => ({ ...c, Config: { ...c.Config, Labels: { ...c.Config.Labels, 'devcontainer.local_folder': folder } } });
    const list = run([local(sandbox('b', 'running'), '/s/b'), vmOf('a', 'running'), local(sandbox('a', 'exited'), '/s/a')], 'list');
    assert.equal(list.status, 0, list.stderr);
    const rows = list.stdout.trim().split('\n').map((line) => line.split(/\s{2,}/));
    assert.deepEqual(rows.map((row) => [row[0], row.at(-1)]),
        [['NAME', 'FOLDER'], ['a', '/s/a'], ['a-vm', 'VM of a'], ['b', '/s/b']]);
});
