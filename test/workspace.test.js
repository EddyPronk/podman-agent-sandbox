import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
    applyWorkspace, findGitDirs, readonlyTargets, readSettings, realConfigDir, resolveWorkspace,
    uncoveredGitPaths, uncoveredInSandbox, workspaceMounts, workspacePath,
} from '../src/workspace.js';

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
    for (const id of ['claude', 'mitm-proxy', 'proxy-client']) {
        JSON.parse(readFileSync(join(templates, id, '.devcontainer', 'devcontainer.json'), 'utf8'));
    }
});
