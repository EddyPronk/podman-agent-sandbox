import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { createServer } from 'node:net';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    PODMAN_STORAGE_PROBE, VSCODE_PROBE, audit, configVolumes, formatBytes, formatCommand, optionValues, parsePodmanStorage,
    parseStatus, parseVscodeProbe, podmanStorageRows, removedRows, shellQuote, splitCommand,
} from '../dist/inspect.js';

// PODMAN_STORAGE_PROBE's output in agent-mitm-proxy's sandbox, with a proxy and a client inside (2026-10-14).
const STORAGE_OUTPUT = `root /home/u/.local/share/containers/storage
disk 3349104
Images|37|1549842647|1091525051
Containers|2|29774|0
Local Volumes|3|21042|0
`;

test('formatBytes: three significant digits, as podman prints sizes', () => {
    assert.equal(formatBytes(512), '512 B');
    assert.equal(formatBytes(1549842647), '1.55 GB');
    assert.equal(formatBytes(29774), '29.8 kB');
    assert.equal(formatBytes(21042), '21 kB');
    assert.equal(formatBytes(100_000_000), '100 MB');
    assert.equal(formatBytes(1_500_000), '1.5 MB');
});

test('parsePodmanStorage and podmanStorageRows: how much podman keeps inside, and whether rm keeps it', () => {
    const storage = parsePodmanStorage(STORAGE_OUTPUT);
    assert.equal(storage.root, '/home/u/.local/share/containers/storage');
    assert.equal(storage.disk, 3349104 * 1024);
    assert.deepEqual(storage.Images, { count: 37, size: 1549842647, reclaimable: 1091525051 });
    const home = { Type: 'volume', Name: 'box-home', Source: '/v/box-home/_data', Destination: '/home/u' };
    const work = { Type: 'bind', Source: '/src/app', Destination: '/home/u/app' };
    assert.deepEqual(podmanStorageRows(storage, [work, home]), [
        ['podman inside', '3.43 GB on disk: images 1.55 GB (37, 1.09 GB reclaimable), containers 29.8 kB (2), volumes 21 kB (3)'],
        ['', 'in volume box-home (/home/u/.local/share/containers/storage): sandbox rm keeps it'],
    ]);
    assert.match(podmanStorageRows(storage, [work])[1][1], /in the container itself .*: sandbox rm removes it/);
    const bind = { Type: 'bind', Source: '/srv/store', Destination: '/home/u/.local/share/containers' };
    assert.match(podmanStorageRows(storage, [home, bind])[1][1], /in host folder \/srv\/store .*: sandbox rm keeps it/,
        'the innermost mount holds it');
    assert.equal(parsePodmanStorage('root /x\ndisk \n').disk, null, 'du failed: no figure');
});

test('configVolumes: the named volumes a config mounts, variables filled in as the CLI does', () => {
    const config = {
        mounts: [
            'type=volume,source=${localWorkspaceFolderBasename}-home,target=/home/${localEnv:USER},U=true',
            'type=bind,source=${localWorkspaceFolder}/.devcontainer,target=/workspace/.devcontainer,readonly',
            { type: 'volume', source: 'cache-${localEnv:CACHE:shared}', target: '/cache' },
            'type=volume,src=box-home,target=/elsewhere',
            'type=tmpfs,target=/tmp',
        ],
    };
    assert.deepEqual(configVolumes(config, '/sb/box', { USER: 'u' }), ['box-home', 'cache-shared']);
    assert.deepEqual(configVolumes({}, '/sb/box'), []);
});

test('removedRows: what is left without a container', () => {
    const settings = { workspace: '/src/app', inplace: true, configTree: 'bd010288d452549c' };
    assert.deepEqual(removedRows('/sb/app', settings, null, [{ name: 'app-home', bytes: 3_430_000_000 }, { name: 'x', bytes: null }]), [
        ['config', '/sb/app'],
        ['workspace', '/src/app'],
        ['project config', '--inplace, trusted bd01028: unchanged since'],
        ['volumes', 'app-home: 3.43 GB on disk; podman volume rm app-home removes it'],
        ['', 'x: doesn\'t exist (the next sandbox enter makes it)'],
    ]);
    assert.deepEqual(removedRows('/sb/plain', null, null, []), [
        ['config', '/sb/plain'], ['workspace', '/sb/plain (the config folder itself)'], ['volumes', 'none'],
    ]);
    assert.match(removedRows('/sb/app', settings, 'changed', [])[2][1], /changed: enter refuses until sandbox trust/);
});

test('PODMAN_STORAGE_PROBE exits 3 where there is no podman', () => {
    const result = spawnSync('/bin/sh', ['-c', PODMAN_STORAGE_PROBE], { env: { PATH: '/nonexistent' } });
    assert.equal(result.status, 3);
});

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

test('parseVscodeProbe: server count, sockets with what their agent answered, helpers', () => {
    const probe = parseVscodeProbe([
        'server 18',
        'agent /tmp/early.sock keys 1',             // before its sock line: ignored
        'sock /tmp/vscode-ssh-auth-a.sock',
        'agent /tmp/vscode-ssh-auth-a.sock keys 1',
        'sock /tmp/vscode-ssh-auth-b.sock',
        'agent /tmp/vscode-ssh-auth-b.sock dead',
        'sock /tmp/vscode-ssh-auth-c.sock',
        'helper /home/node/.gitconfig !f() { /home/node/.vscode-server/bin/x/node /tmp/h.js git-credential-helper $*; }; f',
        'garbage', '',
    ].join('\n'));
    assert.equal(probe.server, 18);
    assert.deepEqual(probe.sockets, [
        { path: '/tmp/vscode-ssh-auth-a.sock', agent: 'keys 1' },
        { path: '/tmp/vscode-ssh-auth-b.sock', agent: 'dead' },
        { path: '/tmp/vscode-ssh-auth-c.sock', agent: 'unknown' },
    ]);
    assert.equal(probe.helpers.length, 1);
    assert.equal(probe.helpers[0].file, '/home/node/.gitconfig');
    assert.match(probe.helpers[0].value, /git-credential-helper/);
});

const vscodeRows = (report) => {
    const i = report.rows.findIndex(([l]) => l === 'vscode');
    if (i < 0) return [];
    const rows = [report.rows[i][1]];
    for (let j = i + 1; j < report.rows.length && report.rows[j][0] === ''; j++) rows.push(report.rows[j][1]);
    return rows;
};

test('audit: VS Code attached now: the answering socket, earlier ones, the helper, two warnings', () => {
    const report = audit(info({ State: { Status: 'running' } }), { vscode: {
        server: 18,
        sockets: [{ path: '/tmp/vscode-ssh-auth-new.sock', agent: 'keys 1' },
            { path: '/tmp/vscode-ssh-auth-old.sock', agent: 'dead' }],
        helpers: [{ file: '/home/node/.gitconfig', value: '!f() { … }; f' }],
    } });
    assert.deepEqual(vscodeRows(report), [
        'VS Code server running (18 processes); it forwards, while VS Code is attached:',
        'SSH agent  /tmp/vscode-ssh-auth-new.sock (answers now: 1 key)',
        'SSH agent  /tmp/vscode-ssh-auth-old.sock (not answering: from an earlier attach)',
        'git        credential.helper in /home/node/.gitconfig: VS Code\'s',
    ]);
    assert.equal(report.warnings.length, 2);
    assert.match(report.warnings[0], /forwards your SSH agent .* \(it answers now\)/);
    assert.match(report.warnings[1], /git credential helper is set/);
});

test('audit: VS Code not attached: still warned, the sockets come back with the next attach', () => {
    const report = audit(info({ State: { Status: 'running' } }), { vscode: {
        server: 8, sockets: [{ path: '/tmp/vscode-ssh-auth-old.sock', agent: 'dead' }], helpers: [] } });
    assert.match(vscodeRows(report)[1], /not answering: VS Code not attached/);
    assert.equal(report.warnings.length, 1);
    assert.match(report.warnings[0], /not answering now; it does again on the next attach/);
});

test('audit: no VS Code, or a server that forwards nothing: no warnings', () => {
    assert.deepEqual(vscodeRows(audit(info(), { vscode: { server: 0, sockets: [], helpers: [] } })), []);
    assert.deepEqual(vscodeRows(audit(info(), { vscode: null })), []);
    const report = audit(info(), { vscode: { server: 3, sockets: [], helpers: [] } });
    assert.deepEqual(vscodeRows(report), ['VS Code server running (3 processes); nothing forwarded found']);
    assert.deepEqual(report.warnings, []);
});

test('audit: host sockets among the mounts: agents, API sockets, X11, D-Bus warned; Wayland a note', () => {
    const mount = (Source, Destination) => ({ Type: 'bind', Source, Destination, RW: true });
    const report = audit(info({ Mounts: [
        mount('/run/user/1000/keyring/ssh', '/ssh-agent'),
        mount('/run/user/1000/podman/podman.sock', '/var/run/docker.sock'),
        mount('/tmp/.X11-unix', '/tmp/.X11-unix'),
        mount('/run/user/1000/bus', '/run/user/1000/bus'),
        mount('/run/user/1000/wayland-0', '/tmp/wayland-0'),
        mount('/home/u/box', '/workspace'),
    ] }));
    assert.equal(report.warnings.length, 4);
    assert.match(report.warnings[0], /keyring\/ssh is mounted at \/ssh-agent: the host's SSH or GPG agent/);
    assert.match(report.warnings[1], /podman\.sock .*API socket/);
    assert.match(report.warnings[2], /X11 display/);
    assert.match(report.warnings[3], /D-Bus/);
    assert.equal(report.notes.length, 1);
    assert.match(report.notes[0], /wayland-0 .*Wayland display/);
});

test('audit: a writable sandbox config gets a warning', () => {
    const report = audit(info(), { configWritable: '/workspace/.devcontainer' });
    assert.equal(report.warnings.length, 1);
    assert.match(report.warnings[0], /own config is writable inside \(\/workspace\/\.devcontainer\).*initializeCommand runs on your machine/);
    assert.deepEqual(audit(info()).warnings, []);
});

test('VSCODE_PROBE is valid sh', () => {
    const result = spawnSync('sh', ['-n', '-c', VSCODE_PROBE], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
});

const AGENT_QUERY = /-e '([^']+)'/.exec(VSCODE_PROBE)[1];

/** The probe's agent query (node -e) on PATH; async, so a fake agent in this process can answer. */
const runQuery = (path) => new Promise((resolve) => {
    execFile(process.execPath, ['-e', AGENT_QUERY, path], { timeout: 10000 }, (err, stdout) => resolve(stdout.trim()));
});

/** Run the agent query against a fake agent on a Unix socket answering ANSWER (null: hang up). */
async function queryFakeAgent(answer) {
    const path = join(mkdtempSync(join(tmpdir(), 'sandbox-agent-')), 'agent.sock');
    const server = createServer((conn) => conn.once('data', () => (answer ? conn.end(answer) : conn.destroy())));
    await new Promise((resolve) => server.listen(path, resolve));
    try {
        return await runQuery(path);
    } finally {
        server.close();
    }
}

test('the agent query reads the key count, and calls a closed or refusing agent what it is', async () => {
    // SSH2_AGENT_IDENTITIES_ANSWER (12) with 2 keys: length 5, type 12, count 2 (key blobs left out).
    assert.equal(await queryFakeAgent(Buffer.from([0, 0, 0, 5, 12, 0, 0, 0, 2])), 'keys 2');
    assert.equal(await queryFakeAgent(Buffer.from([0, 0, 0, 1, 5])), 'refused');   // SSH_AGENT_FAILURE
    assert.equal(await queryFakeAgent(null), 'dead');                               // closes without a word
    const missing = join(mkdtempSync(join(tmpdir(), 'sandbox-agent-')), 'none.sock');
    assert.equal(await runQuery(missing), 'dead');                                  // no agent there
});
