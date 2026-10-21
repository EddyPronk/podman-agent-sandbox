import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { enterPlan, parseConfiguration } from '../dist/sandbox.js';

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
        [{ v: 'exited' }, {}, /x is a VM: to make it a container, 'sandbox rm x' \(volumes are kept\), then 'sandbox enter --container x'/],
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
/** OF's VM: krun, its command naming the image by ID (vm.ts). */
function vmOf(of, status, options = {}) {
    const vm = container(`${of}-vm`, status, { ...options, labels: { 'podman-agent-sandbox.vm-of': of, ...options.labels } });
    const id = 'ab'.repeat(32);
    return { ...vm, Image: id, OCIRuntime: 'krun', HostConfig: { SecurityOpt: ['no-new-privileges'], NetworkMode: 'none' },
        Config: { ...vm.Config, CreateCommand: ['podman', 'run', '-dit', '--runtime', 'krun', '--name', `${of}-vm`, '--userns=keep-id', id, '-l'] } };
}

/** Run sandbox ARGS against the fake podman with CONTAINERS: { status, stdout, stderr, calls, containers }. */
function run(containers, ...args) {
    return runWith({}, containers, ...args);
}

/**
 * run, in a $SANDBOX_DIR with a config folder for each of FOLDERS (names), and RECORDS ({ NAME: kind },
 * state.js), whose folder is $SANDBOX_DIR/NAME. Also returns sandboxDir.
 */
function runWith({ folders = [], records = {} }, containers, ...args) {
    const dir = mkdtempSync(join(tmpdir(), 'sandbox-test-'));
    const stateFile = join(dir, 'state.json');
    const log = join(dir, 'podman.log');
    writeFileSync(stateFile, JSON.stringify({ containers }));
    writeFileSync(log, '');
    mkdirSync(join(dir, 'sandboxes'));
    for (const name of folders) {
        mkdirSync(join(dir, 'sandboxes', name, '.devcontainer'), { recursive: true });
        writeFileSync(join(dir, 'sandboxes', name, '.devcontainer', 'devcontainer.json'), '{}\n');
    }
    mkdirSync(join(dir, 'sandboxes', '.state'));
    for (const [name, kind] of Object.entries(records)) {
        writeFileSync(join(dir, 'sandboxes', '.state', `${name}.json`), JSON.stringify({ kind, folder: join(dir, 'sandboxes', name) }));
    }
    const result = spawnSync(process.execPath, [SANDBOX, ...args], {
        encoding: 'utf8',
        env: { ...process.env, PATH: `${FAKE}:${process.env.PATH}`, SANDBOX_DIR: join(dir, 'sandboxes'), FAKE_PODMAN_STATE: stateFile, FAKE_PODMAN_LOG: log },
    });
    const calls = readFileSync(log, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
    return { ...result, calls, containers: JSON.parse(readFileSync(stateFile, 'utf8')).containers, sandboxDir: join(dir, 'sandboxes') };
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
    assert.equal(inspect.status, 0, inspect.stderr);
    assert.match(inspect.stdout, /^# x-vm is the VM of x: this is sandbox inspect x\.\n\n# x is a VM sandbox/);
    assert.doesNotMatch(inspect.stdout, /not a sandbox/);
    assert.equal(inspect.stdout.replace(/^.*\n\n/, ''), run(state(), 'inspect', 'x').stdout, 'the same as inspect x');
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

// Where the tests run there's no krun or /dev/kvm: a command that goes the VM way stops at that check.
const NO_KVM = /krun not found on PATH|\/dev\/kvm isn't readable/;

test('a VM sandbox: plain enter goes the VM way; enter --container and exec refuse; nothing starts', () => {
    for (const status of ['running', 'exited']) {
        const vmSandbox = () => [sandbox('x', 'exited'), vmOf('x', status)];
        const enter = runWith({ folders: ['x'], records: { x: 'vm' } }, vmSandbox(), 'enter', 'x');
        assert.equal(enter.status, 1, status);
        assert.match(enter.stderr, NO_KVM, `${status}: plain enter follows the record to the VM`);
        assert.deepEqual(changes(enter.calls), []);
        const container = runWith({ folders: ['x'], records: { x: 'vm' } }, vmSandbox(), 'enter', '--container', 'x');
        assert.equal(container.status, 1, status);
        assert.match(container.stderr, /x is a VM: to make it a container, 'sandbox rm x' \(volumes are kept\), then 'sandbox enter --container x'/);
        assert.deepEqual(changes(container.calls), []);
        const exec = runWith({ folders: ['x'], records: { x: 'vm' } }, vmSandbox(), 'exec', 'x', 'true');
        assert.equal(exec.status, 1, status);
        assert.match(exec.stderr, /x is a VM sandbox; exec can't run commands in it\. Use 'sandbox enter x', or, to make it a container: 'sandbox rm x', then 'sandbox enter --container x'/);
        assert.deepEqual(changes(exec.calls), []);
    }
});

test('a VM sandbox stays one after rm: rm says so, exec refuses, inspect and list --removed show it', () => {
    const rm = runWith({ folders: ['x'], records: { x: 'vm' } }, [sandbox('x', 'exited'), vmOf('x', 'exited')], 'rm', 'x');
    assert.equal(rm.status, 0, rm.stderr);
    assert.match(rm.stdout, /x stays a VM sandbox: 'sandbox enter x' makes its VM again \('sandbox enter --container x' makes it a container\)/);
    assert.ok(existsSync(join(rm.sandboxDir, '.state', 'x.json')), 'rm keeps the record');

    const removed = { folders: ['x'], records: { x: 'vm' } };
    const exec = runWith(removed, [], 'exec', 'x', 'true');
    assert.equal(exec.status, 1);
    assert.match(exec.stderr, /x is a VM sandbox; exec can't run commands in it/);
    const enter = runWith(removed, [], 'enter', 'x');
    assert.match(enter.stderr, NO_KVM, 'plain enter would make the VM again');
    const inspect = runWith(removed, [], 'inspect', 'x');
    assert.equal(inspect.status, 0, inspect.stderr);
    assert.match(inspect.stdout, /sandbox enter x creates its VM from its config/);
    assert.match(inspect.stdout, /# x is a VM sandbox: 'sandbox enter x' makes its VM$/m);
    const list = runWith({ folders: ['x', 'y'], records: { x: 'vm' } }, [], 'list', '--removed');
    const rows = list.stdout.trim().split('\n').map((line) => line.split(/\s{2,}/).slice(0, 2));
    assert.deepEqual(rows, [['NAME', 'KIND'], ['x', 'VM'], ['y', 'container']]);
});

test('enter --container after rm forgets that it was a VM sandbox', () => {
    const result = runWith({ folders: ['x'], records: { x: 'vm' } }, [], 'enter', '--container', 'x');
    // The fake podman can't make the container; what matters is that the record went first.
    assert.ok(!existsSync(join(result.sandboxDir, '.state', 'x.json')), 'the record is gone');
    assert.doesNotMatch(result.stderr, NO_KVM);
});

test('a record whose folder is gone counts as gone, and is removed', () => {
    const dir = (r) => join(r.sandboxDir, '.state', 'x.json');
    const stale = runWith({ records: { x: 'vm' } }, [], 'stop', 'x');
    assert.match(stale.stderr, /x has no container or VM to stop/);
    assert.ok(!existsSync(dir(stale)), 'removed');
    // sandbox new of that name: a container sandbox, not the old VM sandbox.
    const again = runWith({ records: { x: 'vm' } }, [], 'new', 'x', '--template', 'offline');
    assert.equal(again.status, 0, again.stderr);
    assert.ok(!existsSync(dir(again)), 'new removed the old record before making the folder');
    assert.match(again.stdout, /^next: sandbox enter x$/m);
});

test('sandbox new --vm: refused, with nothing made, when the machine can\'t run a VM', () => {
    const result = runWith({}, [], 'new', 'x', '--template', 'offline', '--vm');
    assert.equal(result.status, 1);
    assert.match(result.stderr, NO_KVM);
    assert.ok(!existsSync(join(result.sandboxDir, 'x')), 'no folder');
    assert.ok(!existsSync(join(result.sandboxDir, '.state', 'x.json')), 'no record');
});

test('enter: --vm and --container together are refused', () => {
    const result = run([], 'enter', '--vm', '--container', 'x');
    assert.equal(result.status, 1);
    assert.match(result.stderr, /--vm or --container, not both/);
});

test('enter --from-existing needs --vm', () => {
    const result = run([], 'enter', '--from-existing', 'x');
    assert.equal(result.status, 1);
    assert.match(result.stderr, /--from-existing goes with --vm/);
});

test('inspect of a VM sandbox: how its VM runs, then the container it was made from', () => {
    const inspect = runWith({ folders: ['x'], records: { x: 'vm' } }, [sandbox('x', 'exited'), vmOf('x', 'exited')], 'inspect', 'x');
    assert.equal(inspect.status, 0, inspect.stderr);
    assert.match(inspect.stdout, /^# x is a VM sandbox \(label podman-agent-sandbox=0\.8\.0, record \/.*\/\.state\/x\.json\): it runs in its VM, x-vm\.\n/);
    assert.match(inspect.stdout, /^# The command that created x-vm \(podman recorded it\):\npodman run \\\n {4}-dit \\\n {4}--runtime krun \\\n/m);
    assert.match(inspect.stdout, /^# What it runs with \(as podman set it up: podman exec can't reach into a VM\):$/m);
    assert.match(inspect.stdout, /^runtime +krun: a microVM with its own kernel/m);
    assert.match(inspect.stdout, /^user +.*, user namespace keep-id \(you, not root\)$/m);
    assert.match(inspect.stdout, /\n\n# x-vm, made .* from the container as it was then; to make it again: sandbox rm x, then sandbox enter x\n# x, the container it was made from .*: exited, made .*\n$/);
    assert.doesNotMatch(inspect.stdout, /not a sandbox|warning/);

    const busy = run([sandbox('x', 'running'), vmOf('x', 'exited')], 'inspect', 'x');
    assert.match(busy.stdout, /^# x is a VM sandbox \(label podman-agent-sandbox=0\.8\.0\): /, 'without a record');
    assert.match(busy.stdout, /\nwarning: x's container runs: the VM can't start while it does/);
    const alone = run([vmOf('x', 'running')], 'inspect', 'x');
    assert.equal(alone.status, 0, alone.stderr);
    assert.match(alone.stdout, /^# x is a VM sandbox: it runs in its VM, x-vm\./);
    assert.match(alone.stdout, /\n# x has no container left, only its VM\n$/);
});

test('list: one row per sandbox; COMMENT says vm for a VM sandbox, whose row is its VM\'s', () => {
    const local = (c, folder) => ({ ...c, Config: { ...c.Config, Labels: { ...c.Config.Labels, 'devcontainer.local_folder': folder } } });
    const list = runWith({ folders: ['a', 'c', 'd', 'f'], records: { a: 'vm', c: 'vm', d: 'vm', f: 'vm' } }, [
        local(sandbox('b', 'running'), '/s/b'), vmOf('a', 'running'), local(sandbox('a', 'exited'), '/s/a'),
        local(sandbox('c', 'running'), '/s/c'), vmOf('c', 'exited'), vmOf('d', 'exited'), local(sandbox('e', 'exited'), '/s/e'),
        local(sandbox('f', 'exited'), '/s/f'),
    ], 'list');
    assert.equal(list.status, 0, list.stderr);
    const lines = list.stdout.trimEnd().split('\n');
    const rows = lines.map((line) => line.split(/\s{2,}/));
    assert.deepEqual(rows.map((row) => [row[0], row[1], row.slice(2).join('|')]), [
        ['NAME', 'STATE', 'NETWORK|FOLDER|COMMENT'],   // the fake's containers have no networks
        ['a', 'running', '/s/a|vm'],
        ['b', 'running', '/s/b'],
        ['c', 'exited', '/s/c|vm, container running'],
        ['d', 'exited', `${list.sandboxDir}/d|vm`],
        ['e', 'exited', '/s/e'],
        ['f', 'exited', '/s/f|vm, no VM yet'],
    ]);
    assert.deepEqual(lines.filter((line) => line !== line.trimEnd()), [], 'no spaces at the end of a row');
});

test('a command on a sandbox that doesn\'t exist leaves no lock file; one that exists keeps it', () => {
    const typo = run([], 'stop', 'typo');
    assert.equal(typo.status, 1);
    assert.match(typo.stderr, /typo has no container or VM to stop/);
    assert.ok(!existsSync(join(typo.sandboxDir, '.locks', 'typo')), 'no .locks/typo');

    const real = run([sandbox('x', 'running')], 'stop', 'x');
    assert.equal(real.status, 0, real.stderr);
    assert.ok(existsSync(join(real.sandboxDir, '.locks', 'x')), 'the lock file stays for a sandbox that exists');
});

test('parseConfiguration: the merged configuration and the workspace folder; output without a configuration is refused', () => {
    const merged = { remoteEnv: { A: 'b' } };
    assert.deepEqual(parseConfiguration(JSON.stringify({ configuration: {}, mergedConfiguration: merged,
        workspace: { workspaceFolder: '/p' } }), '/d'), { merged, workdir: '/p' });
    assert.deepEqual(parseConfiguration(JSON.stringify({ configuration: merged }), '/d'), { merged, workdir: '/workspace' },
        'without the merged one: the configuration; without a folder: /workspace');
    assert.equal(parseConfiguration(JSON.stringify({ configuration: {}, workspace: { workspaceFolder: 7 } }), '/d').workdir,
        '/workspace');
    for (const out of [null, [], {}, { configuration: 'x' }, { mergedConfiguration: [] }]) {
        assert.throws(() => parseConfiguration(JSON.stringify(out), '/d'),
            /read-configuration gave output sandbox doesn't expect for \/d: no configuration/, JSON.stringify(out));
    }
});
