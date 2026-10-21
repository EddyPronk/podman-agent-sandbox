// A sandbox's normal container: the one the Dev Containers CLI makes and starts (devcontainer up), and
// runs commands in (devcontainer exec). The bottom layer under sandbox.ts: it does what it's told,
// without knowing about the sandbox's other states; the checks before a start are sandbox.ts's.
import {
    SANDBOX_LABEL, SandboxError, dc, exitStatus, folderOf, podman, sandboxReason, unlabelledHint,
} from './devcontainer.js';
import type { SandboxSigns } from './devcontainer.js';
import {
    PODMAN_STORAGE_PROBE, VSCODE_PROBE, audit, formatCommand, isPodmanInfo, parsePodmanStorage, parseStatus,
    parseVscodeProbe, podmanStorageRows, table, writableConfig,
} from './inspect.js';
import type { PodmanInfo, PodmanStorage, ProcStatus, Row, VscodeProbe } from './inspect.js';
import { uncoveredInSandbox } from './workspace.js';

export type { PodmanInfo } from './inspect.js';

/** `podman container inspect` of NAME, or null when there's no such container. */
export function inspectContainer(name: string): PodmanInfo | null {
    const result = podman(['container', 'inspect', name]);
    if (result.status !== 0) return null;
    const parsed: unknown = JSON.parse(result.stdout);
    const unexpected = () => new SandboxError(`podman container inspect ${name} gave output sandbox doesn't expect `
        + '(a podman version it hasn\'t been tried with?): please report it, with podman --version');
    if (!Array.isArray(parsed)) throw unexpected();
    const [info] = parsed;
    if (info === undefined) return null;
    if (!isPodmanInfo(info)) throw unexpected();
    return info;
}

// The states in which a container does nothing: it doesn't exist (''), or it isn't running.
const INACTIVE = new Set(['', 'exited', 'created', 'stopped', 'configured']);

/**
 * Whether a container in STATE is active: running, paused, stopping... anything but INACTIVE. The one
 * definition of "active" (PLAN.md, Definitions).
 */
export function isActive(state: string): boolean {
    return !INACTIVE.has(state);
}

export class Container {
    /** A command can run in it next to the shell (devcontainer exec). */
    canExec = true;

    name: string;
    /** null: the container doesn't exist (yet). */
    info: PodmanInfo | null;

    constructor(name: string, info: PodmanInfo | null) {
        this.name = name;
        this.info = info;
    }

    static load(name: string): Container {
        return new Container(name, inspectContainer(name));
    }

    /** 'running', 'exited', ..., or '' when it doesn't exist. */
    get state(): string {
        return this.info?.State?.Status ?? '';
    }

    get exists(): boolean {
        return this.info !== null;
    }

    get active(): boolean {
        return isActive(this.state);
    }

    get labels(): { [label: string]: string } {
        return this.info?.Config?.Labels ?? {};
    }

    /** The config folder recorded on it (the devcontainer.local_folder label), or ''. */
    get folder(): string {
        return this.labels['devcontainer.local_folder'] ?? '';
    }

    /** The sandbox's config folder: the label's, else $SANDBOX_DIR/NAME (folderOf). */
    get dir(): string {
        return folderOf(this.name, { lookup: () => this.folder });
    }

    /** Whether it carries the sandbox label: { reason, hint } as containerSandbox gives them. */
    get sandbox(): SandboxSigns {
        const reason = sandboxReason({ label: this.labels[SANDBOX_LABEL] });
        return { reason, hint: reason ? '' : unlabelledHint({ folder: this.folder }) };
    }

    /** Destinations of its read-only mounts. */
    readonlyMounts(): string[] {
        return (this.info?.Mounts ?? []).filter((m) => !m.RW).map((m) => m.Destination);
    }

    /** Names of the volumes it mounts. */
    volumes(): string[] {
        return (this.info?.Mounts ?? []).flatMap((m) => (m.Type === 'volume' && m.Name ? [m.Name] : []));
    }

    /**
     * Make it running: devcontainer up creates it (building the image first), or starts it if it exists
     * but is stopped. Creating may take minutes: show that log (on stderr). Starting is quick, and its
     * log only matters when it fails.
     */
    start(): void {
        if (this.state === 'running') return;
        const create = !this.exists;
        console.error(`sandbox: ${create ? 'creating' : 'starting'} ${this.name} ...`);
        const up = dc('up', ['--workspace-folder', this.dir], create
            ? { stdio: ['ignore', 2, 2] }
            : { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
        if (up.status !== 0) {
            if (!create) process.stderr.write(String(up.stdout) + String(up.stderr));
            throw new SandboxError(`failed to start '${this.name}'`);
        }
    }

    stop(): void {
        const result = podman(['stop', this.name]);
        if (result.status !== 0) throw new SandboxError(result.stderr.trim());
    }

    remove(): void {
        const result = podman(['rm', '-f', this.name]);
        if (result.status !== 0) throw new SandboxError(result.stderr.trim());
    }

    /** A login shell as the user, in the workspace; its exit status. */
    openShell(): number {
        return this.exec(['bash', '-l']);
    }

    /**
     * Run COMMAND (argv) as the user, in the workspace folder, with the environment of the shell; its
     * exit status. Node can't exec() in place: run it as a child and pass on its status. Ignore Ctrl-C
     * here so it only reaches the command in the container.
     */
    exec(command: string[]): number {
        const dir = this.dir;
        process.on('SIGINT', () => {});
        // "--" stops the CLI from parsing the command's options (bash -l) as its own.
        return exitStatus(dc('exec', ['--workspace-folder', dir, '--', ...command]));
    }

    /**
     * sandbox inspect for an existing container: the command that created it and what it runs with,
     * measured inside while it runs. UNTRUSTED: how an --inplace sandbox's project config changed since
     * it was trusted, if it did.
     */
    describe({ untrusted = null }: { untrusted?: string | null } = {}): string {
        const { name, info } = this;
        if (!info) throw new SandboxError(`${name} has no container to describe`);
        const { reason, hint } = this.sandbox;
        const header = reason ? `# ${name} is a sandbox (${reason}).`
            : hint ? `# ${name} is not a sandbox: no ${SANDBOX_LABEL} label, though ${hint} (a sandbox made before 0.6.0,`
                + ' or another tool\'s container?).'
                : `# ${name} is not a sandbox: no ${SANDBOX_LABEL} label (VS Code's, or your own?).`;
        return describeInfo(name, info, { header, sandbox: Boolean(reason), folder: this.folder, untrusted });
    }
}

/** describeInfo's OPTIONS. */
export interface DescribeOptions {
    /** The first line(s). */
    header: string;
    /** Whether sandbox made it: the advice is the templates', and its own config is checked. */
    sandbox: boolean;
    /** The sandbox's config folder, for the git paths a --workspace sandbox must have read-only; '' when unknown. */
    folder: string;
    /** As for Container.describe. */
    untrusted?: string | null;
    /** Why nothing can be measured inside (a VM: no podman exec), or '' to measure while it runs. */
    unmeasured?: string;
    /** The sandbox's name, when NAME is its VM's. */
    of?: string;
}

/**
 * sandbox inspect of container NAME (INFO), a sandbox's container or its VM: HEADER, the command that
 * created it, and what it runs with, measured inside while it runs unless UNMEASURED says why not.
 */
export function describeInfo(name: string, info: PodmanInfo, {
    header, sandbox, folder, untrusted = null, unmeasured = '', of = name,
}: DescribeOptions): string {
    const lines = [header];
    const command = info.Config?.CreateCommand ?? [];
    lines.push(`\n# The command that created ${name} (podman recorded it):`);
    lines.push(command.length ? formatCommand(command, info.ImageName ?? '', info.Image)
        : '# (none: podman records it only for the podman command, not for containers made through its API\n'
        + '# socket, as VS Code and other Docker clients do)');

    // Measured inside while it runs: what the processes in it actually have.
    let status: ProcStatus | null = null;
    let vscode: VscodeProbe | null = null;
    let storage: PodmanStorage | null = null;
    if (!unmeasured && info.State?.Status === 'running') {
        const proc = podman(['exec', name, 'cat', '/proc/1/status']);
        if (proc.status === 0) status = parseStatus(proc.stdout);
        // What VS Code forwards when attached: not mounts, so only visible inside (inspect.ts).
        const probe = podman(['exec', name, 'sh', '-c', VSCODE_PROBE]);
        if (probe.status === 0) vscode = parseVscodeProbe(probe.stdout);
        // Podman inside (claude-containers and the like): its images may outlive the container.
        const inner = podman(['exec', name, 'sh', '-c', PODMAN_STORAGE_PROBE]);
        if (inner.status === 0) storage = parsePodmanStorage(inner.stdout);
    }
    const internal: { [network: string]: boolean } = {};
    const networks = Object.keys(info.NetworkSettings?.Networks ?? {});
    if (networks.length) {
        const nets = podman(['network', 'inspect', '--format', '{{.Name}} {{.Internal}}', ...networks]);
        for (const line of nets.stdout.split('\n').filter(Boolean)) {
            const [net, isInternal] = line.split(' ');
            internal[net] = isInternal === 'true';
        }
    }
    let uncovered: string[] = [];
    const configWritable = sandbox ? writableConfig(info, folder) : null;
    if (folder) {
        try {
            uncovered = uncoveredInSandbox(folder, (info.Mounts ?? []).filter((m) => !m.RW).map((m) => m.Destination));
        } catch {
            // the config folder is gone: nothing to compare with
        }
    }
    const report = audit(info, { status, internal, uncovered, sandbox, vscode, configWritable });
    if (untrusted) report.warnings.unshift(`${untrusted}: enter, exec and build refuse until 'sandbox trust ${of}'`);

    const how = unmeasured ? ` (as podman set it up: ${unmeasured})`
        : status ? ' (capabilities, new privileges, seccomp: measured inside)' : '';
    lines.push(`\n# What it runs with${how}:`);
    const rows = [...report.rows, ...report.mounts.map((text, i): Row => [i ? '' : 'mounts', text]),
        ...(storage?.root ? podmanStorageRows(storage, info.Mounts ?? []) : [])];
    lines.push(table(rows));
    if (report.warnings.length || report.notes.length) lines.push('');
    for (const text of report.warnings) lines.push(`warning: ${text}`);
    for (const text of report.notes) lines.push(`note: ${text}`);
    return lines.join('\n');
}
