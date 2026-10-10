import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { audit, formatCommand, optionValues, parseStatus, shellQuote, splitCommand } from '../src/inspect.js';

// As the Dev Containers CLI makes a sandbox: the image without localhost/ and :latest, a boolean
// flag (--init) right before it, and a multi-line script after it.
const IMAGE = 'vsc-box-0123abcd';
const COMMAND = ['podman', 'run', '--sig-proxy=false', '-a', 'STDOUT', '--mount', 'type=tmpfs,target=/w/secrets',
    '--mount', 'type=bind,source=/dev/null,target=/w/key,readonly', '-u', '1000:1000', '--userns=keep-id',
    '--cap-drop=all', '--security-opt=no-new-privileges', '--entrypoint', '/bin/sh', '--init', IMAGE,
    '-c', 'echo started\nexec "$@"', '-'];

/** A `podman container inspect` object; OVERRIDES replace top-level keys. */
function info(overrides = {}) {
    return {
        ImageName: `localhost/${IMAGE}:latest`,
        Config: { User: '1000:1000', CreateCommand: COMMAND, Labels: {} },
        State: { Status: 'exited' },
        BoundingCaps: [],
        HostConfig: { SecurityOpt: ['no-new-privileges'], NetworkMode: 'pasta', PidsLimit: 2048, Memory: 0, Privileged: false },
        NetworkSettings: { Networks: {} },
        Mounts: [
            { Type: 'bind', Source: '/home/u/box', Destination: '/workspace', RW: true },
            { Type: 'volume', Name: 'box-home', Destination: '/home/u', RW: true },
            { Type: 'bind', Source: '/dev/null', Destination: '/w/key', RW: false },
            { Type: 'bind', Source: '/w/.git/hooks', Destination: '/w/.git/hooks', RW: false },
        ],
        ...overrides,
    };
}

const row = (report, label) => report.rows.find(([l]) => l === label)?.[1];

test('shellQuote: bare when safe, single quotes otherwise, $\'…\' for control characters', () => {
    assert.equal(shellQuote('--mount=type=bind,source=/a/b'), '--mount=type=bind,source=/a/b');
    assert.equal(shellQuote(''), "''");
    assert.equal(shellQuote('/proc/*'), "'/proc/*'");
    assert.equal(shellQuote("it's"), "'it'\\''s'");
    assert.equal(shellQuote('a\nb\'c\\d\te'), "$'a\\nb\\'c\\\\d\\te'");
});

test('splitCommand pairs flags with values up to the image, and keeps the command after it', () => {
    const split = splitCommand(COMMAND, `localhost/${IMAGE}:latest`);
    assert.deepEqual(split.head, ['podman', 'run']);
    assert.deepEqual(split.options.slice(0, 3), [['--sig-proxy=false'], ['-a', 'STDOUT'], ['--mount', 'type=tmpfs,target=/w/secrets']]);
    assert.deepEqual(split.options.at(-1), ['--init'], 'a flag right before the image takes no value');
    assert.equal(split.image, IMAGE);
    assert.deepEqual(split.args, ['-c', 'echo started\nexec "$@"', '-']);
    assert.equal(splitCommand(COMMAND, 'other-image'), null);
});

test('formatCommand: one option per line, and the shell reads back the same words', () => {
    const text = formatCommand(COMMAND, IMAGE);
    const lines = text.split('\n');
    assert.equal(lines[0], 'podman run \\');
    assert.equal(lines[2], '    -a STDOUT \\');
    assert.equal(lines.at(-1), `    ${IMAGE} -c $'echo started\\nexec "$@"' -`);
    // bash parses it back into exactly the argv podman recorded.
    const words = spawnSync('bash', ['-c', `set -- ${text.replace(/^podman /, '')}; printf '%s\\0' run "$@"`],
        { encoding: 'utf8' }).stdout.split('\0').slice(0, -1);
    assert.deepEqual(['podman', ...words.slice(1)], COMMAND);
});

test('formatCommand falls back to one word per line without the image', () => {
    assert.equal(formatCommand(['podman', 'run', '-d', 'img'], 'other'), 'podman run \\\n    -d \\\n    img');
});

test('optionValues reads --flag=value and --flag value', () => {
    const options = [['--security-opt=seccomp=/p.json'], ['--security-opt', 'label=disable'], ['--device=/dev/net/tun']];
    assert.deepEqual(optionValues(options, '--security-opt'), ['seccomp=/p.json', 'label=disable']);
    assert.deepEqual(optionValues(options, '--device'), ['/dev/net/tun']);
    assert.deepEqual(optionValues(options, '--dev'), []);
});

test('parseStatus picks the fields that matter', () => {
    assert.deepEqual(parseStatus('Name:\tsh\nCapBnd:\t0000000000000000\nNoNewPrivs:\t1\nSeccomp:\t2\n'),
        { CapBnd: '0000000000000000', NoNewPrivs: '1', Seccomp: '2' });
});

test('audit: a hardened sandbox has no warnings, and hidden paths show as hidden', () => {
    const report = audit(info());
    assert.deepEqual(report.warnings, []);
    assert.deepEqual(report.notes, []);
    assert.equal(row(report, 'user'), '1000:1000, user namespace keep-id (you, not root)');
    assert.equal(row(report, 'capabilities'), 'none (empty bounding set)');
    assert.equal(row(report, 'new privileges'), 'blocked (no-new-privileges)');
    assert.equal(row(report, 'seccomp'), "Podman's default profile");
    assert.equal(row(report, 'network'), 'pasta: Internet, LAN and services on the host');
    assert.equal(row(report, 'limits'), 'processes 2048, memory no limit');
    assert.deepEqual(report.mounts, [
        'rw      /home/u (volume box-home)',
        'ro      /w/.git/hooks',
        'hidden  /w/key (empty file)',
        'hidden  /w/secrets (empty folder)',
        'rw      /workspace (from /home/u/box)',
    ]);
});

test('audit: an unhardened sandbox gets one warning, a nested-podman one a note', () => {
    const caps = ['CAP_CHOWN', 'CAP_SETUID'];
    const plain = audit(info({ BoundingCaps: caps, HostConfig: { NetworkMode: 'pasta' } }));
    assert.equal(row(plain, 'capabilities'), '2 in the bounding set: chown, setuid');
    assert.equal(row(plain, 'new privileges'), 'allowed: setuid and file-capability programs gain rights');
    assert.equal(plain.warnings.length, 1);
    assert.match(plain.warnings[0], /^2 capabilities in the bounding set, no-new-privileges off: .*--cap-drop=all/);

    const nested = audit(info({ BoundingCaps: caps, HostConfig: { NetworkMode: 'pasta', Devices: [{ PathOnHost: '/dev/net/tun' }] } }));
    assert.deepEqual(nested.warnings, []);
    assert.match(nested.notes[0], /like claude-containers/);
    assert.equal(row(nested, 'devices'), '/dev/net/tun');
});

test('audit: a container sandbox did not make gets podman advice, not the templates\'', () => {
    const report = audit(info({ BoundingCaps: ['CAP_SETUID'], HostConfig: { NetworkMode: 'pasta' } }), { sandbox: false });
    assert.equal(report.warnings.length, 1);
    assert.match(report.warnings[0], /podman run --cap-drop=all --security-opt=no-new-privileges prevents it$/);
    assert.doesNotMatch(report.warnings[0], /templates/);
});

test('audit: measured values from inside beat the configuration', () => {
    const report = audit(info({ BoundingCaps: ['CAP_KILL'] }), { status: { CapBnd: '0000000000000000', NoNewPrivs: '1', Seccomp: '2' } });
    assert.equal(row(report, 'capabilities'), 'none (empty bounding set)');
    const off = audit(info(), { status: { CapBnd: '0000000000000000', NoNewPrivs: '0', Seccomp: '0' } });
    assert.equal(row(off, 'new privileges'), 'allowed: setuid and file-capability programs gain rights');
    assert.equal(row(off, 'seccomp'), 'off (unconfined)');
    assert.equal(off.warnings.length, 2);
});

test('audit: networks, privileged, host network, unmask and uncovered git paths', () => {
    const proxied = audit(info({ HostConfig: { SecurityOpt: ['no-new-privileges'], NetworkMode: 'bridge' },
        NetworkSettings: { Networks: { 'agent-proxy-net': {}, 'agent-egress': {} } } }), { internal: { 'agent-proxy-net': true } });
    assert.equal(row(proxied, 'network'), 'agent-proxy-net (internal: no route out), agent-egress (routed: Internet and LAN)');

    const bad = audit(info({ HostConfig: { SecurityOpt: ['no-new-privileges', 'seccomp=unconfined', 'unmask=/proc/*'],
        NetworkMode: 'host', Privileged: true } }), { uncovered: ['/w/sub/.git/config'] });
    assert.equal(row(bad, '/proc'), 'unmasked: /proc/*');
    assert.deepEqual(bad.warnings.map((w) => w.split(':')[0]), ['privileged', 'seccomp is off', 'host network',
        'writable inside, and git on the host runs what it names']);

    const root = audit(info({ Config: { CreateCommand: [] } }));
    assert.equal(row(root, 'user'), "root (the image's default)");
});
