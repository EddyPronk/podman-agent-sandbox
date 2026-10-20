import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
    CONFIG_MOUNT, applyWorkspace, findGitDirs, findSecretFiles, readConfig, readonlyTargets, readSettings, realConfigDir,
    resolveWorkspace, uncoveredGitPaths, uncoveredInSandbox, workspaceMounts, workspacePath,
} from '../dist/workspace.js';

const SANDBOX = fileURLToPath(new URL('../bin/sandbox.js', import.meta.url));

function tempDir() {
    return realpathSync(mkdtempSync(join(tmpdir(), 'sandbox-test-')));
}

/** A fake git dir: enough of .git for the protection (hooks and config). */
function gitRepo(dir) {
    mkdirSync(join(dir, '.git', 'hooks'), { recursive: true });
    writeFileSync(join(dir, '.git', 'config'), '');
}

/** A project with a repo at the root, a nested repo, and repos where none must be found. */
function project() {
    const root = tempDir();
    gitRepo(root);
    gitRepo(join(root, 'libs', 'nested'));
    gitRepo(join(root, 'node_modules', 'dep'));
    gitRepo(join(root, '.venv', 'src', 'pkg'));
    mkdirSync(join(root, 'secrets'));
    writeFileSync(join(root, 'secrets', 'key'), 'secret');
    writeFileSync(join(root, '.env'), 'TOKEN=x');
    writeFileSync(join(root, 'notes.md'), '');
    return root;
}

function sandbox(args, env) {
    return spawnSync(process.execPath, [SANDBOX, ...args],
        { encoding: 'utf8', env: { ...process.env, ...env }, cwd: env.CWD ?? process.cwd() });
}

test('resolveWorkspace resolves relative paths and symlinks, and refuses bad ones', () => {
    const root = tempDir();
    mkdirSync(join(root, 'real'));
    symlinkSync(join(root, 'real'), join(root, 'link'));
    assert.equal(resolveWorkspace('real', root), join(root, 'real'));
    assert.equal(resolveWorkspace(join(root, 'link')), join(root, 'real'));
    writeFileSync(join(root, 'file'), '');
    mkdirSync(join(root, 'a,b'));
    assert.throws(() => resolveWorkspace(join(root, 'missing')), /does not exist/);
    assert.throws(() => resolveWorkspace(join(root, 'file')), /not a directory/);
    assert.throws(() => resolveWorkspace(join(root, 'a,b')), /comma/);
    assert.throws(() => resolveWorkspace('/'), /can't be \//);
});

test('findGitDirs finds repos at the root and nested, not in node_modules, .venv or hidden paths', () => {
    const root = project();
    assert.deepEqual(findGitDirs(root), [join(root, '.git'), join(root, 'libs', 'nested', '.git')]);
    assert.deepEqual(findGitDirs(root, [join(root, 'libs')]), [join(root, '.git')]);
});

test('findGitDirs refuses a .git file (worktree or submodule)', () => {
    const root = tempDir();
    gitRepo(root);
    mkdirSync(join(root, 'sub'));
    writeFileSync(join(root, 'sub', '.git'), 'gitdir: ../.git/modules/sub\n');
    assert.throws(() => findGitDirs(root), /sub\/\.git is a file/);
});

test('findGitDirs does not follow symlinks out of the workspace', () => {
    const root = tempDir();
    const outside = tempDir();
    gitRepo(outside);
    symlinkSync(outside, join(root, 'elsewhere'));
    assert.deepEqual(findGitDirs(root), []);
});

test('workspacePath stays inside the workspace and must exist', () => {
    const root = project();
    assert.equal(workspacePath(root, 'secrets', 'hide'), join(root, 'secrets'));
    assert.equal(workspacePath(root, 'secrets/../.env', 'hide'), join(root, '.env'));
    assert.throws(() => workspacePath(root, 'missing', 'hide'), /does not exist/);
    assert.throws(() => workspacePath(root, '../x', 'hide'), /not a path inside/);
    assert.throws(() => workspacePath(root, '.', 'readonly'), /not a path inside/);
    mkdirSync(join(root, 'a,b'));
    assert.throws(() => workspacePath(root, 'a,b', 'readonly'), /comma/);
    symlinkSync(join(root, 'secrets'), join(root, 'alias'));
    assert.throws(() => workspacePath(root, 'alias', 'hide'), /symlink/);
    assert.throws(() => workspacePath(root, 'alias/key', 'hide'), /under a symlink/);
});

test('workspaceMounts: git hooks and config, --readonly, --hide by type, the config folder', () => {
    const root = project();
    const nested = join(root, 'libs', 'nested');
    const configDir = join(root, 'sandboxes', 'box');
    const mounts = workspaceMounts({
        workspace: root,
        hide: [join(root, 'secrets'), join(root, '.env')],
        readonly: [join(root, 'notes.md')],
        configDir,
        gitDirs: findGitDirs(root),
    });
    const ro = (p) => `type=bind,source=${p},target=${p},readonly`;
    assert.deepEqual(new Set(mounts), new Set([
        ro(join(root, '.git', 'config')),
        ro(join(root, '.git', 'hooks')),
        ro(join(nested, '.git', 'config')),
        ro(join(nested, '.git', 'hooks')),
        ro(join(root, 'notes.md')),
        ro(configDir),
        `type=tmpfs,target=${join(root, 'secrets')},notmpcopyup`,
        `type=bind,source=/dev/null,target=${join(root, '.env')},readonly`,
    ]));
    const order = mounts.map((m) => m.match(/target=([^,]+)/)[1].split('/').length);
    assert.deepEqual(order, [...order].sort((a, b) => a - b), 'outer paths first');
});

test('workspaceMounts leaves out the config folder when it is outside the workspace', () => {
    const root = project();
    const mounts = workspaceMounts({ workspace: root, configDir: join(tempDir(), 'box'), gitDirs: [] });
    assert.deepEqual(mounts, []);
});

test('workspaceMounts refuses a repo without hooks, which the agent could create', () => {
    const root = tempDir();
    mkdirSync(join(root, '.git'));
    writeFileSync(join(root, '.git', 'config'), '');
    assert.throws(() => workspaceMounts({ workspace: root, gitDirs: findGitDirs(root) }), /hooks is missing/);
});

test('applyWorkspace rewrites the config and records the choices', () => {
    const configDir = tempDir();
    mkdirSync(join(configDir, '.devcontainer'));
    const file = join(configDir, '.devcontainer', 'devcontainer.json');
    writeFileSync(file, JSON.stringify({
        workspaceFolder: '/workspace',
        workspaceMount: 'source=${localWorkspaceFolder},target=/workspace,type=bind',
        mounts: ['type=volume,source=x-home,target=/home/u,U=true'],
    }));
    applyWorkspace(configDir, { workspace: '/p', hide: ['.env'], readonly: [], mounts: ['m1'] });
    const config = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(config.workspaceMount, 'source=/p,target=/p,type=bind');
    assert.equal(config.workspaceFolder, '/p');
    assert.deepEqual(config.mounts, ['type=volume,source=x-home,target=/home/u,U=true', 'm1']);
    assert.deepEqual(readSettings(configDir), { workspace: '/p', hide: ['.env'], readonly: [] });
});

test('applyWorkspace drops the read-only /workspace/.devcontainer mount of the template', () => {
    // With --workspace the config stays outside the project (or is mounted read-only where it is).
    const configDir = tempDir();
    mkdirSync(join(configDir, '.devcontainer'));
    const file = join(configDir, '.devcontainer', 'devcontainer.json');
    writeFileSync(file, JSON.stringify({ mounts: ['type=volume,source=x-home,target=/home/u', CONFIG_MOUNT] }));
    applyWorkspace(configDir, { workspace: '/p', hide: [], readonly: [], mounts: ['m1'] });
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).mounts, ['type=volume,source=x-home,target=/home/u', 'm1']);
});

test('applyWorkspace refuses a config with comments rather than lose them', () => {
    const configDir = tempDir();
    mkdirSync(join(configDir, '.devcontainer'));
    writeFileSync(join(configDir, '.devcontainer', 'devcontainer.json'), '{\n  // a comment\n  "name": "x"\n}');
    assert.throws(() => applyWorkspace(configDir, { workspace: '/p', hide: [], readonly: [], mounts: [] }),
        /isn't plain JSON/);
});

test('uncoveredGitPaths compares against the read-only mount targets', () => {
    const gitDirs = ['/p/.git', '/p/sub/.git'];
    assert.deepEqual(uncoveredGitPaths(gitDirs, ['/p/.git/hooks', '/p/.git/config', '/p/sub/.git/hooks']),
        ['/p/sub/.git/config']);
    assert.deepEqual(uncoveredGitPaths(gitDirs, []).length, 4);
});

test('readonlyTargets reads the read-only targets of a mounts list', () => {
    assert.deepEqual(readonlyTargets([
        'type=bind,source=/a,target=/a,readonly',
        'type=bind,source=/b,target=/b',
        'type=volume,source=v,target=/home/u,U=true',
        'type=bind,source=/dev/null,target=/p/.env,readonly',
        { type: 'bind', source: '/c', target: '/c' },
    ]), ['/a', '/p/.env']);
});

test('findSecretFiles: .env files, keys and key stores, not examples, .git, node_modules or hidden paths', () => {
    const root = project();   // has .env and secrets/key
    for (const file of ['.env.local', '.env.example', 'tls/server.pem', 'tls/server.key', 'store.p12',
        'deploy/id_ed25519', 'deploy/id_ed25519.pub', '.netrc', 'keys.md', 'node_modules/dep/test.pem', '.git/x.key',
        'home/.claude/.credentials.json', 'gcp/credentials.json', 'credentials.md']) {
        mkdirSync(join(root, file, '..'), { recursive: true });
        writeFileSync(join(root, file), '');
    }
    assert.deepEqual(findSecretFiles(root), ['.env', '.env.local', '.netrc', 'deploy/id_ed25519', 'gcp/credentials.json',
        'home/.claude/.credentials.json', 'store.p12', 'tls/server.key', 'tls/server.pem']);
    assert.deepEqual(findSecretFiles(root, [join(root, 'tls'), join(root, '.env'), join(root, 'home'), join(root, 'gcp')]),
        ['.env.local', '.netrc', 'deploy/id_ed25519', 'store.p12']);
});

test('an unreadable folder in the workspace is skipped, not a crash (the agent can\'t read it either)', () => {
    const root = project();
    mkdirSync(join(root, 'pgdata'));
    writeFileSync(join(root, 'pgdata', 'server.key'), '');
    chmodSync(join(root, 'pgdata'), 0o000);
    try {
        assert.deepEqual(findGitDirs(root), [join(root, '.git'), join(root, 'libs', 'nested', '.git')]);
        assert.deepEqual(findSecretFiles(root), ['.env']);
    } finally {
        chmodSync(join(root, 'pgdata'), 0o755);
    }
});

test('sandbox new --workspace warns about files that may hold secrets, unless hidden', () => {
    const root = project();
    writeFileSync(join(root, 'server.key'), '');
    const warned = sandbox(['new', 'w1', '--template', 'claude', '--workspace', root], { SANDBOX_DIR: tempDir() });
    assert.equal(warned.status, 0, warned.stderr);
    assert.match(warned.stderr, /warning: w1 can read files whose names suggest secrets:\n {2}\.env\n {2}server\.key\n/);
    assert.match(warned.stderr, /To hide them inside: rm -r .*\/w1, then this command again with --hide PATH/);
    const quiet = sandbox(['new', 'w2', '--template', 'claude', '--workspace', root, '--hide', '.env', '--hide', 'server.key'],
        { SANDBOX_DIR: tempDir() });
    assert.equal(quiet.status, 0, quiet.stderr);
    assert.doesNotMatch(quiet.stderr, /secrets/);
});

test('sandbox new --workspace on a project in SANDBOX_DIR under its own name: says so, never "rm -r" the project', () => {
    const sandboxes = tempDir();
    const root = join(sandboxes, 'foo');
    mkdirSync(root);
    gitRepo(root);
    for (const extra of [[], ['--inplace']]) {
        const result = sandbox(['new', '--template', 'offline', '--workspace', root, ...extra], { SANDBOX_DIR: sandboxes });
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, new RegExp(`config folder would be ${root}, which is your project itself `
            + '\\(NAME defaults to the project folder\'s name, foo\\)'));
        assert.match(result.stderr, /sandbox new foo-sandbox --workspace /);
        assert.doesNotMatch(result.stderr, /rm -r/);
    }
    mkdirSync(join(sandboxes, 'group', 'app'), { recursive: true });
    const around = sandbox(['new', 'group', '--template', 'offline', '--workspace', join(sandboxes, 'group', 'app')],
        { SANDBOX_DIR: sandboxes });
    assert.match(around.stderr, /which contains your project/);
    assert.ok(!existsSync(join(root, '.devcontainer')) && !existsSync(join(root, 'sandbox.json')), 'the project is untouched');
    assert.equal(sandbox(['new', 'foo-box', '--template', 'offline', '--workspace', root], { SANDBOX_DIR: sandboxes }).status, 0);
});

test('already exists: rm -r only for a folder that holds nothing but config', () => {
    const sandboxes = tempDir();
    const env = { SANDBOX_DIR: sandboxes };
    // Made without --workspace: the folder is the sandbox's workspace, with the work in it.
    assert.equal(sandbox(['new', 'plain', '--template', 'offline'], env).status, 0);
    const plain = sandbox(['new', 'plain', '--template', 'offline'], env);
    assert.match(plain.stderr, /a sandbox made from a template, and its workspace/);
    assert.match(plain.stderr, new RegExp(`move the folder aside, with the work in it \\(mv ${sandboxes}/plain ${sandboxes}/plain\\.old\\)`));
    assert.doesNotMatch(plain.stderr, /rm -r/);
    // A folder sandbox didn't make.
    mkdirSync(join(sandboxes, 'mine'));
    const mine = sandbox(['new', 'mine', '--template', 'offline'], env);
    assert.match(mine.stderr, /a folder, not a sandbox[\s\S]*To use this NAME: +move the folder out of /);
    assert.doesNotMatch(mine.stderr, /rm -r|To use it:/);
    // --workspace: only config in it, the project elsewhere.
    const root = project();
    assert.equal(sandbox(['new', 'w', '--template', 'offline', '--workspace', root], env).status, 0);
    const ws = sandbox(['new', 'w', '--template', 'offline', '--workspace', root], env);
    assert.match(ws.stderr, new RegExp(`rm -r ${sandboxes}/w \\(only its config: ${root} stays\\)`));
});

test('realConfigDir resolves the part that exists', () => {
    const root = tempDir();
    symlinkSync(root, join(root, 'link'));
    assert.equal(realConfigDir(join(root, 'link', 'sandboxes', 'box')), join(root, 'sandboxes', 'box'));
});

test('sandbox new --workspace: config outside the project, nothing written into it', () => {
    const root = project();
    const sandboxes = tempDir();
    const result = sandbox(['new', '--template', 'claude', '--workspace', root, '--hide', 'secrets',
        '--hide', '.env', '--readonly', 'notes.md'], { SANDBOX_DIR: sandboxes });
    assert.equal(result.status, 0, result.stderr);
    const name = root.split('/').pop();   // NAME defaults to the folder's name
    const configDir = join(sandboxes, name);
    const config = JSON.parse(readFileSync(join(configDir, '.devcontainer', 'devcontainer.json'), 'utf8'));
    assert.equal(config.workspaceFolder, root);
    assert.equal(config.workspaceMount, `source=${root},target=${root},type=bind`);
    assert.ok(config.mounts.includes(`type=bind,source=${root}/.git/hooks,target=${root}/.git/hooks,readonly`));
    assert.ok(config.mounts[0].startsWith('type=volume'), "the template's own mounts come first");
    assert.deepEqual(readSettings(configDir), { workspace: root, hide: ['secrets', '.env'], readonly: ['notes.md'] });
    assert.ok(!existsSync(join(root, '.devcontainer')));
    assert.match(result.stdout, /2 git repos' hooks and config/);
});

test('sandbox new --workspace: relative path, config folder inside the workspace gets a read-only mount', () => {
    const root = project();
    const result = sandbox(['new', 'box', '--template', 'claude', '--workspace', '.'],
        { SANDBOX_DIR: join(root, 'sandboxes'), CWD: root });
    assert.equal(result.status, 0, result.stderr);
    const configDir = join(root, 'sandboxes', 'box');
    const config = JSON.parse(readFileSync(join(configDir, '.devcontainer', 'devcontainer.json'), 'utf8'));
    assert.equal(config.workspaceFolder, root);
    assert.ok(config.mounts.includes(`type=bind,source=${configDir},target=${configDir},readonly`));
});

test('sandbox new --workspace refuses bad input and leaves nothing behind', () => {
    const root = project();
    const sandboxes = tempDir();
    const env = { SANDBOX_DIR: sandboxes };
    const cases = [
        [['new', 'box', '--template', 'claude', '--workspace', join(root, 'missing')], /does not exist/],
        [['new', 'box', '--template', 'claude', '--workspace', root, '--hide', 'missing'], /does not exist/],
        [['new', 'box', '--template', 'claude', '--hide', 'secrets'], /need --workspace/],
        [['new', '--template', 'claude'], /usage/],
    ];
    for (const [args, message] of cases) {
        const result = sandbox(args, env);
        assert.equal(result.status, 1, args.join(' '));
        assert.match(result.stderr, message);
        assert.ok(!existsSync(join(sandboxes, 'box')), `nothing created for: ${args.join(' ')}`);
    }
});

test('the enter check: a repo added later is caught, in the config and in the container', () => {
    const root = project();
    const sandboxes = tempDir();
    assert.equal(sandbox(['new', 'box', '--template', 'claude', '--workspace', root, '--hide', 'secrets'],
        { SANDBOX_DIR: sandboxes }).status, 0);
    const configDir = join(sandboxes, 'box');
    assert.deepEqual(uncoveredInSandbox(configDir, null), []);

    gitRepo(join(root, 'added'));
    gitRepo(join(root, 'secrets', 'hidden-repo'));   // hidden inside, so not a problem
    const added = [join(root, 'added', '.git', 'hooks'), join(root, 'added', '.git', 'config')].sort();
    assert.deepEqual(uncoveredInSandbox(configDir, null).sort(), added);

    // An existing container keeps its mounts: those count, not the config.
    const containerMounts = readonlyTargets(JSON.parse(
        readFileSync(join(configDir, '.devcontainer', 'devcontainer.json'), 'utf8')).mounts);
    assert.deepEqual(uncoveredInSandbox(configDir, [...containerMounts, ...added]), []);
    assert.equal(uncoveredInSandbox(configDir, []).length, 6);
});

test('the enter check ignores sandboxes made without --workspace', () => {
    const sandboxes = tempDir();
    assert.equal(sandbox(['new', 'plain', '--template', 'claude'], { SANDBOX_DIR: sandboxes }).status, 0);
    assert.deepEqual(uncoveredInSandbox(join(sandboxes, 'plain'), null), []);
});

test('every bundled template works with --workspace (plain JSON config)', () => {
    const templates = fileURLToPath(new URL('../templates/', import.meta.url));
    for (const id of ['claude', 'mitm-proxy', 'offline', 'proxy-client']) {
        JSON.parse(readFileSync(join(templates, id, '.devcontainer', 'devcontainer.json'), 'utf8'));
    }
});

test('readConfig refuses JSON that is no devcontainer.json, with a message, not a TypeError', () => {
    const dir = tempDir();
    const file = join(dir, 'devcontainer.json');
    for (const json of ['null', '[]', '"x"', '{"mounts": "type=bind,source=/a,target=/a"}']) {
        writeFileSync(file, json);
        assert.throws(() => readConfig(file), (err) => err.name === 'Error' && /isn't a devcontainer.json/.test(err.message), json);
    }
    writeFileSync(file, '{"mounts": [], "image": "x"}');
    assert.deepEqual(readConfig(file), { mounts: [], image: 'x' });
});

test('readSettings refuses a sandbox.json without the fields sandbox reads', () => {
    const dir = tempDir();
    const file = join(dir, 'sandbox.json');
    for (const json of ['null', '{}', '{"workspace": 1}', '{"workspace": "/p", "hide": ".env"}',
        '{"workspace": "/p", "readonly": [1]}', '{"workspace": "/p", "inplace": "yes"}', '{"workspace": "/p", "configTree": 7}']) {
        writeFileSync(file, json);
        assert.throws(() => readSettings(dir), (err) => err.name === 'Error' && /isn't a sandbox.json/.test(err.message), json);
    }
    const settings = { workspace: '/p', hide: ['.env'], readonly: [], inplace: true, configTree: 'abc' };
    writeFileSync(file, JSON.stringify(settings));
    assert.deepEqual(readSettings(dir), settings);
});

test('readConfig and readonlyTargets take null mounts as none, as the Dev Containers CLI does', () => {
    const file = join(tempDir(), 'devcontainer.json');
    writeFileSync(file, '{"image": "x", "mounts": null}');
    assert.deepEqual(readConfig(file), { image: 'x', mounts: null });
    assert.deepEqual(readonlyTargets(null), []);
});
