import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { checkNotWeaker, parseOptions, vmPolicy, vmRunArgs } from '../src/vm.js';

// Real `podman container inspect` output, one per bundled template and one --workspace sandbox (a git
// repo in a git repo, --hide of a file and a folder, claude-containers' seccomp), recorded in nested
// sandboxes and anonymised (~/sandbox/lab/35-enter-vm-2: record-fixtures.sh, anonymise.mjs).
const FIXTURES = new URL('./fixtures/vm/', import.meta.url);
const fixtures = Object.fromEntries(readdirSync(FIXTURES).filter((f) => f.endsWith('.json'))
    .map((f) => [f.replace('.json', ''), JSON.parse(readFileSync(new URL(f, FIXTURES), 'utf8'))]));
const ENV = { TERM: 'xterm-256color', USER: 'user', LOGNAME: 'user' };

/** vmRunArgs for INFO (a fixture), with COMMAND instead of its recorded one if given. */
function argsFor(info, command = info.Config.CreateCommand) {
    return vmRunArgs({
        command, imageName: info.ImageName, image: info.Image, name: info.Name,
        workdir: '/workspace', env: ENV,
    });
}

const KEEP_ALIVE = 'echo Container started\ntrap "exit 0" 15\n\nexec "$@"\nwhile sleep 1 & wait $!; do :; done';

test('vmPolicy: a config with no-vm, a postStartCommand or a postAttachCommand can\'t run as a VM', () => {
    const marker = (policies) => ({ customizations: { 'podman-agent-sandbox': { version: 1, policies } } });
    const table = [
        [{}, true],
        [marker([]), true],
        [{ ...marker([]), postCreateCommand: 'cp -r /etc/skel/. ~' }, true],
        [marker(['no-vm']), /policies include no-vm/],
        [{ customizations: { 'podman-agent-sandbox': [{ policies: [] }, { policies: ['no-vm'] }] } }, /policies include no-vm/],
        [{ postStartCommand: '/opt/start-proxy.sh' }, /wouldn't run its postStartCommand \(\/opt\/start-proxy\.sh\)/],
        [{ postAttachCommand: ['echo', 'hi'] }, /wouldn't run its postAttachCommand \(echo hi\)/],
        [{ postStartCommand: { proxy: 'start.sh' } }, /postStartCommand \(proxy: start\.sh\)/],
        // mergedConfiguration: lists, from Features and image metadata too
        [{ postStartCommands: [], postAttachCommands: [] }, true],
        [{ postStartCommands: ['dockerd &'] }, /postStartCommand \(dockerd &\)/],
        [{ postStartCommand: {} }, true],
    ];
    for (const [config, expected] of table) {
        const answer = vmPolicy(config);
        if (expected === true) assert.deepEqual(answer, { allowed: true }, JSON.stringify(config));
        else assert.match(answer.allowed ? '' : answer.reason, expected, JSON.stringify(config));
    }
});

test('vmRunArgs, from each recorded command: krun, the image ID, a login shell; nothing confining lost', () => {
    assert.deepEqual(Object.keys(fixtures).sort(),
        ['claude', 'claude-containers', 'mitm-proxy', 'offline', 'proxy-client', 'workspace-claude-containers']);
    for (const [id, info] of Object.entries(fixtures)) {
        const args = argsFor(info);
        const text = args.join('\n');
        assert.deepEqual(args.slice(0, 5), ['run', '-dit', '--runtime', 'krun', '--name'], id);
        assert.equal(args[5], `${info.Name}-vm`, id);
        assert.deepEqual(args.slice(-2), [info.Image, '-l'], `${id}: the image it was made from, not its name`);
        assert.ok(text.includes(`podman-agent-sandbox.vm-of=${info.Name}`), id);
        assert.ok(!text.includes('vm-folder'), `${id}: no folder label (the record has it)`);
        assert.ok(!args.includes('-a') && !args.includes('--sig-proxy=false'), `${id}: -a and --sig-proxy dropped`);
        assert.ok(!/devcontainer\.|podman-agent-sandbox=|\/bin\/sh|echo Container started/.test(text), `${id}: labels, entrypoint, keep-alive dropped`);
        assert.equal(args.filter((a) => a === '--name').length, 1, id);
        assert.equal(args.filter((a) => a === '--entrypoint').length, 1, id);
        assert.deepEqual(args.slice(args.indexOf('--entrypoint'), args.indexOf('--entrypoint') + 4),
            ['--entrypoint', '/bin/bash', '--workdir', '/workspace'], id);
        for (const [key, value] of Object.entries(ENV)) assert.ok(text.includes(`-e\n${key}=${value}`), `${id}: ${key}`);
        // Every option of the original but the dropped ones, in order (R4.2, said again here).
        const original = info.Config.CreateCommand;
        const keptOriginal = original.slice(2, original.indexOf('--entrypoint'));
        for (let i = 0; i < keptOriginal.length; i += 1) {
            const token = keptOriginal[i];
            if (['--mount', '-u', '--security-opt', '-e', '--hostname'].includes(token)) {
                assert.ok(text.includes(`${token}\n${keptOriginal[i + 1]}`), `${id}: ${token} ${keptOriginal[i + 1]}`);
            }
            if (/^--(userns|cap-drop|security-opt|network|device)=/.test(token)) assert.ok(args.includes(token), `${id}: ${token}`);
        }
    }
});

test('vmRunArgs keeps a --workspace sandbox\'s protection: read-only git mounts, --hide, seccomp, devices', () => {
    const text = argsFor(fixtures['workspace-claude-containers']).join('\n');
    for (const mount of [
        'type=bind,source=/home/user/project/.git/hooks,target=/home/user/project/.git/hooks,readonly',
        'type=bind,source=/home/user/project/.git/config,target=/home/user/project/.git/config,readonly',
        'type=bind,source=/home/user/project/sub/.git/hooks,target=/home/user/project/sub/.git/hooks,readonly',
        'type=bind,source=/dev/null,target=/home/user/project/.env,readonly',
        'type=tmpfs,target=/home/user/project/secrets,notmpcopyup',
    ]) assert.ok(text.includes(`--mount\n${mount}`), mount);
    assert.ok(text.includes('--security-opt=seccomp=/home/user/sandboxes/fx-ws/.devcontainer/seccomp.json'));
    assert.ok(text.includes('--device=/dev/net/tun'));
    assert.ok(text.includes('--security-opt=unmask=/proc/*'));
});

test('vmRunArgs: the image is found from the end, also when an option\'s value is its name', () => {
    const info = fixtures.offline;
    const command = [...info.Config.CreateCommand];
    const short = info.ImageName.replace(/^localhost\//, '').replace(/:latest$/, '');
    command.splice(command.indexOf('--hostname') + 1, 1, short);
    const args = argsFor(info, command);
    assert.ok(args.join('\n').includes(`--hostname\n${short}`), 'the value is kept as a value');
    assert.deepEqual(args.slice(-2), [info.Image, '-l']);
    // No keep-alive tail at all (overrideCommand without a command): accepted.
    assert.deepEqual(argsFor(info, command.slice(0, -3)).slice(-2), [info.Image, '-l']);
    // podman by its path.
    assert.equal(argsFor(info, ['/usr/bin/podman', ...command.slice(1)])[0], 'run');
});

test('vmRunArgs refuses a container it can\'t copy faithfully', () => {
    const info = fixtures.claude;
    const command = info.Config.CreateCommand;
    const image = command.length - 4;
    const cases = [
        [[...command.slice(0, image + 1), 'sleep', 'infinity'], /keep-alive/, 'a command after the image (overrideCommand: false)'],
        [[...command.slice(0, image + 2), KEEP_ALIVE.replace('\n\n', '\n/usr/local/share/docker-init.sh\n'), '-'], /entrypoint/,
            'a Feature\'s entrypoint in the script'],
        [[...command.slice(0, 2), '--frobnicate', ...command.slice(2)], /unknown option --frobnicate/, 'an unknown option'],
        [[...command.slice(0, 2), '--frobnicate=1', ...command.slice(2)], /unknown option --frobnicate/, 'an unknown option='],
        [['docker', ...command.slice(1)], /not made with podman run/, 'not podman'],
        [['podman', 'create', ...command.slice(2)], /not made with podman run/, 'podman create'],
        [command.slice(0, image), /keep-alive/, 'no image'],
    ];
    for (const [cmd, expected, what] of cases) assert.throws(() => argsFor(info, cmd), expected, what);
});

test('vmRunArgs drops every form of the options a VM doesn\'t take', () => {
    const info = fixtures.offline;
    const command = [...info.Config.CreateCommand];
    command.splice(2, 0, '--attach=STDIN', '-aSTDOUT', '--name=other', '--entrypoint=/bin/zsh', '--label=devcontainer.x=1',
        '-l', 'podman-agent-sandbox=0.1.0', '--label', 'mine=kept');
    const args = argsFor(info, command);
    for (const gone of ['--attach=STDIN', '-aSTDOUT', '--name=other', '--entrypoint=/bin/zsh', '--label=devcontainer.x=1', 'podman-agent-sandbox=0.1.0']) {
        assert.ok(!args.includes(gone), gone);
    }
    assert.ok(args.join('\n').includes('--label\nmine=kept'), 'other labels stay');
});

test('parseOptions: values joined, separate, or attached to a short flag', () => {
    assert.deepEqual(parseOptions(['--userns=keep-id', '-u', '1000', '-aSTDOUT', '--rm', '--read-only=false']).map((o) => [o.flag, o.value]),
        [['--userns', 'keep-id'], ['-u', '1000'], ['-a', 'STDOUT'], ['--rm', null], ['--read-only', 'false']]);
    assert.throws(() => parseOptions(['--mount']), /--mount without its value/);
    assert.throws(() => parseOptions(['image']), /'image' where an option was expected/);
});

test('checkNotWeaker: the post-condition catches a confining option lost on the way', () => {
    const original = ['--mount', 'type=bind,source=/a,target=/a,readonly', '--cap-drop=all', '--read-only', '--name', 'x'];
    const options = parseOptions(original);
    assert.doesNotThrow(() => checkNotWeaker(original, options, ['--mount', 'type=bind,source=/a,target=/a,readonly', '--cap-drop=all', '--read-only']));
    assert.throws(() => checkNotWeaker(original, options, ['--mount', 'type=bind,source=/a,target=/a,readonly', '--read-only']),
        /weaker than the container: it would lose --cap-drop=all/);
    assert.throws(() => checkNotWeaker(original, options, ['--cap-drop=all', '--read-only', '--mount', 'type=bind,source=/a,target=/a,readonly']),
        /weaker than the container/, 'reordered');
});
