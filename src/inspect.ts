// sandbox inspect: the podman command that created a sandbox, and what it runs with.
// Pure functions over `podman container inspect` output; container.ts does the podman calls.
import { existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import { resolveLocalEnv } from './inplace.js';
import { isBoolean, isNumber, isObject, isString, isStringList, nullable, optional } from './json.js';
import type { Check, JsonObject } from './json.js';
import { SETTINGS } from './workspace.js';
import type { DevcontainerConfig, Settings } from './workspace.js';

/**
 * What sandbox reads of `podman container inspect` (one element of its JSON list); isPodmanInfo
 * checks it. Its lists and maps may be null: see isPodmanInfo.
 */
export interface PodmanInfo {
    Id: string;
    /** The container's name. */
    Name?: string;
    /** RFC 3339. */
    Created: string;
    /** The image's ID. */
    Image: string;
    /** The image's name as given to podman run. */
    ImageName?: string;
    State: { Status: string };
    Config: { CreateCommand?: string[] | null; Labels?: { [label: string]: string } | null; User?: string };
    HostConfig?: PodmanHostConfig | null;
    BoundingCaps?: string[] | null;
    Mounts?: PodmanMount[] | null;
    NetworkSettings?: { Networks?: { [network: string]: unknown } | null } | null;
}

export interface PodmanHostConfig {
    Privileged?: boolean;
    SecurityOpt?: string[] | null;
    Devices?: { PathOnHost: string }[] | null;
    NetworkMode?: string;
    PidsLimit?: number;
    Memory?: number;
}

export interface PodmanMount {
    /** 'bind', 'volume', 'tmpfs'. */
    Type: string;
    /** A volume's name. */
    Name?: string;
    Source: string;
    Destination: string;
    RW: boolean;
}

const listOf = <T>(check: Check<T>) => (value: unknown): value is T[] => Array.isArray(value) && value.every(check);

function isMount(value: unknown): value is PodmanMount {
    return isObject(value) && isString(value.Type) && isString(value.Source) && isString(value.Destination)
        && isBoolean(value.RW) && optional(value.Name, isString);
}

function isHostConfig(value: unknown): value is PodmanHostConfig {
    return isObject(value) && optional(value.Privileged, isBoolean) && nullable(value.SecurityOpt, isStringList)
        && nullable(value.Devices, listOf((d): d is { PathOnHost: string } => isObject(d) && isString(d.PathOnHost)))
        && optional(value.NetworkMode, isString) && optional(value.PidsLimit, isNumber) && optional(value.Memory, isNumber);
}

/**
 * Whether VALUE (one element of `podman container inspect`'s JSON) has what PodmanInfo says, as far
 * as sandbox reads it. Id, Created, Image, State.Status and Config must be there. The lists and maps
 * may be null: BoundingCaps is null after --cap-drop=all (seen with podman 5.4.2); for the others it
 * is assumed, not seen (Go writes a nil slice or map as null). Every reader takes null as empty, as
 * sandbox did before these checks, and where that matters it fails safe: no read-only Mounts means
 * the git paths count as unprotected, and enter refuses.
 */
export function isPodmanInfo(value: unknown): value is PodmanInfo {
    if (!isObject(value) || !isObject(value.State) || !isObject(value.Config)) return false;
    const { State: state, Config: config } = value;
    return isString(value.Id) && isString(value.Created) && isString(value.Image)
        && optional(value.Name, isString) && optional(value.ImageName, isString) && isString(state.Status)
        && nullable(config.CreateCommand, isStringList) && optional(config.User, isString)
        && nullable(config.Labels, (labels): labels is { [label: string]: string } => isObject(labels)
            && Object.values(labels).every(isString))
        && nullable(value.BoundingCaps, isStringList) && nullable(value.HostConfig, isHostConfig)
        && nullable(value.Mounts, listOf(isMount))
        && nullable(value.NetworkSettings, (n): n is JsonObject => isObject(n) && nullable(n.Networks, isObject));
}

/** A row of `sandbox inspect`: label and text. */
export type Row = [label: string, text: string];

/** An option of a command line: [flag] or [flag, value]. */
export type CommandOption = [flag: string] | [flag: string, value: string];

/** splitCommand's parts of a `podman run` command line. */
export interface SplitCommand {
    head: string[];
    options: CommandOption[];
    image: string;
    args: string[];
}

/** What parseStatus reads of /proc/PID/status. */
export interface ProcStatus {
    CapBnd?: string;
    NoNewPrivs?: string;
    Seccomp?: string;
}

export interface VscodeProbe {
    server: number;
    sockets: { path: string; agent: string }[];
    helpers: { file: string; value: string }[];
}

/** What `podman system df` reports, per type. */
export interface StorageUsage {
    count: number;
    size: number;
    reclaimable: number;
}

const STORAGE_TYPES = ['Images', 'Containers', 'Local Volumes'] as const;
type StorageType = typeof STORAGE_TYPES[number];

export type PodmanStorage = { root: string; disk: number | null } & { [type in StorageType]?: StorageUsage };

/** A volume a config mounts, and its size: null when it doesn't exist. */
export interface VolumeSize {
    name: string;
    bytes: number | null;
}

/** audit's OPTIONS: what was measured inside, and what sandbox knows about the container. */
export interface AuditOptions {
    status?: ProcStatus | null;
    internal?: { [network: string]: boolean };
    uncovered?: string[];
    sandbox?: boolean;
    vscode?: VscodeProbe | null;
    configWritable?: string | null;
}

export interface Audit {
    rows: Row[];
    mounts: string[];
    warnings: string[];
    notes: string[];
}

const SAFE = /^[A-Za-z0-9_@%+=:,./-]+$/;

/** ARG quoted for the shell: bare when safe, else '…'; $'…' (bash, zsh) when it has control characters. */
export function shellQuote(arg: string): string {
    if (SAFE.test(arg)) return arg;
    if (/[\x00-\x1f\x7f]/.test(arg)) {
        const escaped = arg.replace(/[\\']/g, '\\$&').replace(/\n/g, '\\n').replace(/\t/g, '\\t')
            .replace(/[\x00-\x1f\x7f]/g, (c) => `\\x${c.charCodeAt(0).toString(16).padStart(2, '0')}`);
        return `$'${escaped}'`;
    }
    return `'${arg.replace(/'/g, `'\\''`)}'`;
}

/** An image reference as the Dev Containers CLI passes it: without localhost/ and :latest. */
const bare = (image: string) => image.replace(/^localhost\//, '').replace(/:latest$/, '');

/**
 * Split a `podman run` command line into [program, subcommand], the options as [flag] or
 * [flag, value], the image, and the command after it. IMAGE (from inspect) is where the options
 * end: a flag followed by a word that isn't the image takes it as its value. Null when the image
 * isn't found.
 */
export function splitCommand(argv: string[], image: string): SplitCommand | null {
    const want = bare(image);
    const options: CommandOption[] = [];
    for (let i = 2; i < argv.length; i++) {
        const arg = argv[i];
        if (!arg.startsWith('-')) {
            return bare(arg) === want ? { head: argv.slice(0, 2), options, image: arg, args: argv.slice(i + 1) } : null;
        }
        const next = argv[i + 1];
        if (!arg.includes('=') && next !== undefined && !next.startsWith('-') && bare(next) !== want) {
            options.push([arg, next]);
            i++;
        } else {
            options.push([arg]);
        }
    }
    return null;
}

/** The command as a shell command line: one option per line, the image and its command last. */
export function formatCommand(argv: string[], image: string): string {
    const split = splitCommand(argv, image);
    const lines: string[][] = split
        ? [split.head, ...split.options, [split.image, ...split.args]]
        : [argv.slice(0, 2), ...argv.slice(2).map((arg) => [arg])];
    return lines.map((words) => words.map(shellQuote).join(' ')).join(' \\\n    ');
}

/** Every value given to FLAG, as --flag=value or --flag value. */
export function optionValues(options: CommandOption[], flag: string): string[] {
    const values: string[] = [];
    for (const [name, value] of options) {
        if (name === flag && value !== undefined) values.push(value);
        else if (name.startsWith(`${flag}=`)) values.push(name.slice(flag.length + 1));
    }
    return values;
}

/** CapBnd, NoNewPrivs and Seccomp from a /proc/PID/status text. */
export function parseStatus(text: string): ProcStatus {
    const status: ProcStatus = {};
    for (const line of text.split('\n')) {
        const m = /^(CapBnd|NoNewPrivs|Seccomp):\s*(\S+)/.exec(line);
        if (m) status[m[1] as keyof ProcStatus] = m[2];
    }
    return status;
}

// What VS Code forwards into a container it attaches to (Dev Containers, "Attach to Running
// Container"): none of it is a mount, so it's measured inside. While attached, VS Code relays an SSH
// agent socket (/tmp/vscode-ssh-auth-*.sock) to the host's agent, and sets a git credential.helper
// that asks VS Code on the host for credentials. Both stay after VS Code detaches, and work again on
// the next attach. The agent is asked only for its key list (as `ssh-add -l`), with the node that
// VS Code's server brings, since the image may have no ssh-add. POSIX sh; one line per finding:
//   server N | sock PATH | agent PATH keys N|refused|dead|unknown | helper FILE VALUE
const AGENT_QUERY = 'const s=require("net").connect(process.argv[1]);let b=Buffer.alloc(0),done=0;'
    + 'const out=(t)=>{if(!done){done=1;console.log(t);s.destroy();}};setTimeout(()=>out("dead"),3000).unref();'
    + 's.on("connect",()=>s.write(Buffer.from([0,0,0,1,11])));'
    + 's.on("data",(d)=>{b=Buffer.concat([b,d]);if(b.length>=5&&b.length>=4+b.readUInt32BE(0))'
    + 'out(b[4]===12&&b.length>=9?"keys "+b.readUInt32BE(5):"refused");});'
    + 's.on("error",()=>out("dead"));s.on("close",()=>out("dead"));';

export const VSCODE_PROBE = `
n=0
for c in /proc/[0-9]*/cmdline; do
    [ "$c" = "/proc/$$/cmdline" ] && continue    # this script: it names .vscode-server/ too
    case "$(tr '\\0' ' ' <"$c" 2>/dev/null)" in *.vscode-server/*) n=$((n + 1)) ;; esac
done
echo "server $n"
node=$(ls /root/.vscode-server/bin/*/node /home/*/.vscode-server/bin/*/node 2>/dev/null | head -n 1)
for f in /tmp/vscode-ssh-auth-*.sock; do
    [ -S "$f" ] && [ ! -L "$f" ] || continue
    echo "sock $f"
    if [ -n "$node" ]; then
        echo "agent $f $("$node" -e '${AGENT_QUERY}' "$f" 2>/dev/null || echo unknown)"
    elif command -v ssh-add >/dev/null 2>&1; then
        SSH_AUTH_SOCK=$f ssh-add -l >/dev/null 2>&1
        case $? in 0) echo "agent $f keys $(SSH_AUTH_SOCK=$f ssh-add -l | wc -l)" ;; 1) echo "agent $f keys 0" ;; *) echo "agent $f dead" ;; esac
    else
        echo "agent $f unknown"
    fi
done
for g in /root/.gitconfig /home/*/.gitconfig; do
    [ -r "$g" ] || continue
    grep -E '^[[:space:]]*helper[[:space:]]*=.*vscode' "$g" 2>/dev/null \\
        | sed "s|^[[:space:]]*helper[[:space:]]*=[[:space:]]*|helper $g |"
done
`;

/** VSCODE_PROBE's output → { server, sockets: [{ path, agent }], helpers: [{ file, value }] }. */
export function parseVscodeProbe(text: string): VscodeProbe {
    const probe: VscodeProbe = { server: 0, sockets: [], helpers: [] };
    for (const line of text.split('\n')) {
        const [kind, ...rest] = line.trim().split(' ');
        if (kind === 'server') probe.server = Number(rest[0]) || 0;
        if (kind === 'sock' && rest[0]) probe.sockets.push({ path: rest[0], agent: 'unknown' });
        if (kind === 'agent') {
            const socket = probe.sockets.find((s) => s.path === rest[0]);
            if (socket) socket.agent = rest.slice(1).join(' ') || 'unknown';
        }
        if (kind === 'helper' && rest.length > 1) probe.helpers.push({ file: rest[0], value: rest.slice(1).join(' ') });
    }
    return probe;
}

/**
 * Podman inside a sandbox (claude-containers and the like): where its storage is, how much is on
 * disk, and podman's own summary. Exit 3: no podman inside. `podman unshare du`: plain du can't read
 * the files that inner containers' users own, and counts far too little.
 */
export const PODMAN_STORAGE_PROBE = `
command -v podman >/dev/null 2>&1 || exit 3
root=$(podman info --format '{{.Store.GraphRoot}}') || exit 1
echo "root $root"
echo "disk $(podman unshare du -sk "$root" 2>/dev/null | cut -f1)"
podman system df --format '{{.Type}}|{{.Total}}|{{.RawSize}}|{{.RawReclaimable}}'
`;

/** PODMAN_STORAGE_PROBE's output → { root, disk (bytes or null), Images: { count, size, reclaimable }, ... }. */
export function parsePodmanStorage(text: string): PodmanStorage {
    const storage: PodmanStorage = { root: '', disk: null };
    for (const line of text.split('\n')) {
        if (line.startsWith('root ')) storage.root = line.slice(5).trim();
        else if (line.startsWith('disk ')) {
            const kb = Number(line.slice(5).trim());
            storage.disk = line.slice(5).trim() && Number.isFinite(kb) ? kb * 1024 : null;
        } else {
            const [type, count, size, reclaimable] = line.split('|');
            if (count !== undefined && isStorageType(type)) storage[type] = { count: Number(count), size: Number(size), reclaimable: Number(reclaimable) };
        }
    }
    return storage;
}

function isStorageType(type: string): type is StorageType {
    return (STORAGE_TYPES as readonly string[]).includes(type);
}

/** BYTES as podman prints sizes: 1.55 GB, 29.8 kB. */
export function formatBytes(bytes: number): string {
    const units = ['B', 'kB', 'MB', 'GB', 'TB'];
    let value = bytes;
    let unit = 0;
    while (value >= 1000 && unit < units.length - 1) {
        value /= 1000;
        unit += 1;
    }
    if (!unit) return `${bytes} B`;
    // Three significant digits, without trailing zeros after the point: 1.55 GB, 29.8 kB, 21 kB, 100 MB.
    const digits = value.toFixed(value >= 100 ? 0 : value >= 10 ? 1 : 2);
    return `${digits.includes('.') ? digits.replace(/\.?0+$/, '') : digits} ${units[unit]}`;
}

/**
 * Rows for `sandbox inspect` about STORAGE (parsePodmanStorage), and where it lives among MOUNTS
 * (podman inspect's Mounts): in a volume or host folder, `sandbox rm` keeps it; in the container
 * itself, rm removes it.
 */
export function podmanStorageRows(storage: PodmanStorage, mounts: PodmanMount[] = []): Row[] {
    const part = (type: StorageType, label: string) => {
        const t = storage[type];
        if (!t) return null;
        const free = t.reclaimable ? `, ${formatBytes(t.reclaimable)} reclaimable` : '';
        return `${label} ${formatBytes(t.size)} (${t.count}${free})`;
    };
    const parts = [part('Images', 'images'), part('Containers', 'containers'), part('Local Volumes', 'volumes')]
        .filter(Boolean);
    const disk = storage.disk === null ? '' : `${formatBytes(storage.disk)} on disk: `;
    const holder = mounts
        .filter((m) => storage.root === m.Destination || storage.root.startsWith(`${m.Destination}/`))
        .sort((a, b) => b.Destination.length - a.Destination.length)[0];
    const where = !holder ? `in the container itself (${storage.root}): sandbox rm removes it`
        : holder.Type === 'volume' ? `in volume ${holder.Name} (${storage.root}): sandbox rm keeps it`
            : `in host folder ${holder.Source} (${storage.root}): sandbox rm keeps it`;
    return [['podman inside', `${disk}${parts.join(', ')}`], ['', where]];
}

/**
 * The named volumes that CONFIG (a devcontainer.json) mounts, for the sandbox whose config folder is
 * FOLDER: ${localWorkspaceFolderBasename} and ${localEnv:…} (from ENV) filled in, as the Dev
 * Containers CLI does. They outlive the container: `sandbox rm` keeps them.
 */
export function configVolumes(config: DevcontainerConfig, folder: string, env: NodeJS.ProcessEnv = {}): string[] {
    const names: string[] = [];
    for (const mount of config.mounts ?? []) {
        const fields = typeof mount === 'string' ? mountFields(mount) : isObject(mount) ? mount : {};
        const source = fields.source ?? fields.src;
        if (fields.type !== 'volume' || typeof source !== 'string' || !source) continue;
        names.push(resolveLocalEnv(source.replaceAll('${localWorkspaceFolderBasename}', basename(folder)), env));
    }
    return [...new Set(names)];
}

/**
 * `sandbox inspect` of a sandbox without a container (removed, or not created yet): rows about what
 * is left. FOLDER: its config folder; SETTINGS: its sandbox.json or null; UNTRUSTED: how an --inplace
 * project's config changed, or null; VOLUMES: [{ name, bytes }], bytes null when the volume doesn't
 * exist (the next `sandbox enter` makes it).
 */
export function removedRows(folder: string, settings: Settings | null, untrusted: string | null, volumes: VolumeSize[]): Row[] {
    const rows: Row[] = [['config', folder], ['workspace', settings?.workspace ?? `${folder} (the config folder itself)`]];
    if (settings?.inplace) {
        rows.push(['project config', `--inplace, trusted ${String(settings.configTree ?? '').slice(0, 7)}: `
            + (untrusted ? `${untrusted}: enter refuses until sandbox trust` : 'unchanged since')]);
    }
    volumes.forEach(({ name, bytes }, i) => {
        rows.push([i ? '' : 'volumes', bytes === null ? `${name}: doesn't exist (the next sandbox enter makes it)`
            : `${name}: ${formatBytes(bytes)} on disk; podman volume rm ${name} removes it`]);
    });
    if (!volumes.length) rows.push(['volumes', 'none']);
    return rows;
}

/** What an agent's answer means, for people. ATTACHED: another socket answers now. */
function agentState(agent: string, attached: boolean): string {
    const keys = /^keys (\d+)$/.exec(agent);
    if (keys) return `answers now: ${keys[1]} key${keys[1] === '1' ? '' : 's'}`;
    if (agent === 'dead') return attached ? 'not answering: from an earlier attach' : 'not answering: VS Code not attached';
    return agent === 'refused' ? 'answers, but refused the key list' : 'not checked';
}

// Host sockets that give a container more than files: [test on the mount source, what it means, warn?].
const HOST_SOCKETS: [test: RegExp, meaning: string, warn: boolean][] = [
    [/(keyring\/ssh|ssh-agent|\/agent\.\d+|\/S\.gpg-agent(\.ssh)?)$/,
        'the host\'s SSH or GPG agent: any process inside can use your keys', true],
    [/(podman|docker)\.sock$/, 'a Podman or Docker API socket: control of containers outside this one', true],
    [/^\/tmp\/\.X11-unix/, 'the X11 display: any X client can read the input of the other windows', true],
    [/(\/bus|dbus\/system_bus_socket)$/, 'a D-Bus socket: the desktop\'s or the system\'s services', true],
    [/\/pipewire-\d+$/, 'PipeWire: audio and screen capture', true],
    [/\/wayland-\d+$/, 'the Wayland display: windows on your desktop, and the clipboard while focused', false],
];

/** KEY=VALUE pairs of a --mount value. */
function mountFields(spec: string): { [key: string]: string } {
    return Object.fromEntries(spec.split(',').map((kv) => [kv.split('=')[0], kv.split('=').slice(1).join('=')]));
}

const capName = (cap: string) => cap.replace(/^CAP_/, '').toLowerCase();

/**
 * What container INFO (one `podman container inspect` object) runs with, and what to warn about.
 * status: parseStatus() of /proc/1/status inside, when it runs (measured beats configured).
 * internal: network name -> true when internal (no route out).
 * uncovered: git paths a --workspace sandbox should have read-only and doesn't.
 * sandbox: false for a container `sandbox` didn't make: the advice is podman's, not the templates'.
 * vscode: parseVscodeProbe() of VSCODE_PROBE run inside, when it runs.
 * configWritable: where the sandbox's own .devcontainer is writable inside (a sandbox made before the
 * templates mounted it read-only), or null.
 * Returns { rows: [[label, text]], mounts: [text], warnings: [text], notes: [text] }.
 */
export function audit(info: PodmanInfo, {
    status = null, internal = {}, uncovered = [], sandbox = true, vscode = null, configWritable = null,
}: AuditOptions = {}): Audit {
    const host: PodmanHostConfig = info.HostConfig ?? {};
    const split = splitCommand(info.Config?.CreateCommand ?? [], info.ImageName ?? '');
    const options = split?.options ?? [];
    // Inspect's own fields where it has them; the command line for what it leaves out (unmask, devices).
    const securityOpts = host.SecurityOpt ?? [];
    const unmasked = [...new Set([...securityOpts, ...optionValues(options, '--security-opt')]
        .filter((o) => o.startsWith('unmask=')).map((o) => o.slice(7)))];
    const devices = [...new Set([...(host.Devices ?? []).map((d) => d.PathOnHost),
        ...optionValues(options, '--device').map((d) => d.split(':')[0])])];
    const nested = devices.includes('/dev/net/tun');
    const rows: Row[] = [];
    const warnings: string[] = [];
    const notes: string[] = [];
    const unhardened: string[] = [];

    rows.push(['state', info.State?.Status ?? '?']);
    const userns = optionValues(options, '--userns').at(-1);
    const user = info.Config?.User || 'root (the image\'s default)';
    rows.push(['user', `${user}${userns ? `, user namespace ${userns}${userns === 'keep-id' ? ' (you, not root)' : ''}` : ''}`]);
    if (host.Privileged) warnings.push('privileged: the container has every capability and device');

    const caps = info.BoundingCaps ?? [];
    const capsNone = status ? BigInt(`0x${status.CapBnd ?? '0'}`) === 0n : caps.length === 0;
    rows.push(['capabilities', capsNone ? 'none (empty bounding set)'
        : `${caps.length} in the bounding set: ${caps.map(capName).join(', ')}`]);
    if (!capsNone) unhardened.push(`${caps.length} capabilities in the bounding set`);

    const noNewPrivs = status ? status.NoNewPrivs === '1' : securityOpts.includes('no-new-privileges');
    rows.push(['new privileges', noNewPrivs ? 'blocked (no-new-privileges)'
        : 'allowed: setuid and file-capability programs gain rights']);
    if (!noNewPrivs) unhardened.push('no-new-privileges off');
    if (unhardened.length && nested) {
        notes.push(`${unhardened.join(', ')}: expected for a sandbox that runs podman inside, like claude-containers`);
    } else if (unhardened.length && sandbox) {
        warnings.push(`${unhardened.join(', ')}: setuid and file-capability programs can gain rights. The templates `
            + 'since 0.5.2 add --cap-drop=all and --security-opt=no-new-privileges to runArgs (then sandbox rm, sandbox enter)');
    } else if (unhardened.length) {
        warnings.push(`${unhardened.join(', ')}: setuid and file-capability programs (sudo) can gain rights; `
            + 'podman run --cap-drop=all --security-opt=no-new-privileges prevents it');
    }

    const seccomp = securityOpts.filter((o) => o.startsWith('seccomp=')).map((o) => o.slice(8)).at(-1);
    if (seccomp === 'unconfined' || status?.Seccomp === '0') {
        rows.push(['seccomp', 'off (unconfined)']);
        warnings.push('seccomp is off: every system call is allowed');
    } else {
        rows.push(['seccomp', seccomp ? `profile ${seccomp}` : 'Podman\'s default profile']);
    }

    rows.push(['devices', devices.join(', ') || 'none']);
    rows.push(['/proc', unmasked.length ? `unmasked: ${unmasked.join(', ')}` : 'masked (Podman\'s default)']);

    const mode = host.NetworkMode ?? '';
    const networks = Object.keys(info.NetworkSettings?.Networks ?? {});
    if (mode === 'none') {
        rows.push(['network', 'none']);
    } else if (mode === 'host') {
        rows.push(['network', 'host: the host\'s own network']);
        warnings.push('host network: services on the host\'s localhost are reachable');
    } else if (mode === 'pasta' || mode === 'slirp4netns') {
        rows.push(['network', `${mode}: Internet, LAN and services on the host`]);
    } else {
        rows.push(['network', networks.map((n) => `${n} (${internal[n] ? 'internal: no route out' : 'routed: Internet and LAN'})`)
            .join(', ') || mode]);
    }

    const pids = host.PidsLimit ? String(host.PidsLimit) : 'no limit';
    const memory = host.Memory ? `${Math.round(host.Memory / 2 ** 20)} MiB` : 'no limit';
    rows.push(['limits', `processes ${pids}, memory ${memory}`]);

    const mounts: [target: string, text: string][] = [];
    for (const m of info.Mounts ?? []) {
        if (m.Type === 'bind' && m.Source === '/dev/null') {
            mounts.push([m.Destination, `hidden  ${m.Destination} (empty file)`]);
        } else if (m.Type === 'volume') {
            mounts.push([m.Destination, `${m.RW ? 'rw' : 'ro'}      ${m.Destination} (volume ${m.Name})`]);
        } else {
            const from = m.Source === m.Destination ? '' : ` (from ${m.Source})`;
            mounts.push([m.Destination, `${m.RW ? 'rw' : 'ro'}      ${m.Destination}${from}`]);
        }
    }
    for (const spec of optionValues(options, '--mount')) {
        const f = mountFields(spec);
        const target = f.target ?? f.destination ?? f.dst;
        if (f.type === 'tmpfs' && target) mounts.push([target, `hidden  ${target} (empty folder)`]);
    }
    mounts.sort((a, b) => a[0].localeCompare(b[0]));

    for (const m of info.Mounts ?? []) {
        if (m.Type !== 'bind') continue;
        const known = HOST_SOCKETS.find(([test]) => test.test(m.Source ?? ''));
        if (!known) continue;
        const text = `${m.Source} is mounted at ${m.Destination}: ${known[1]}`;
        (known[2] ? warnings : notes).push(text);
    }

    if (vscode && (vscode.server || vscode.sockets.length || vscode.helpers.length)) {
        const forwards = vscode.sockets.length || vscode.helpers.length;
        const attached = vscode.sockets.some((socket) => /^keys \d+$/.test(socket.agent));
        rows.push(['vscode', `VS Code server ${vscode.server ? `running (${vscode.server} processes)` : 'not running'}`
            + (forwards ? '; it forwards, while VS Code is attached:' : '; nothing forwarded found')]);
        for (const socket of vscode.sockets) rows.push(['', `SSH agent  ${socket.path} (${agentState(socket.agent, attached)})`]);
        for (const helper of vscode.helpers) rows.push(['', `git        credential.helper in ${helper.file}: VS Code's`]);
        const live = vscode.sockets.filter((s) => /^keys [1-9]/.test(s.agent));
        const docs = 'https://github.com/EddyPronk/podman-agent-sandbox/blob/main/docs/vscode.md';
        if (vscode.sockets.length) {
            warnings.push(`VS Code forwards your SSH agent into this container while attached${live.length
                ? ' (it answers now)' : ' (not answering now; it does again on the next attach)'}: any process inside `
                + `can use your SSH keys then. See ${docs}`);
        }
        if (vscode.helpers.length) {
            warnings.push('VS Code\'s git credential helper is set: while VS Code is attached, any process inside can '
                + `ask it for your git credentials (e.g. a GitHub token). See ${docs}`);
        }
    }

    for (const path of uncovered) warnings.push(`writable inside, and git on the host runs what it names: ${path}`);
    if (configWritable) {
        warnings.push(`the sandbox's own config is writable inside (${configWritable}): the next container creation `
            + '(sandbox rm and enter, or build) uses what is there then, and an initializeCommand runs on your machine. '
            + 'Add the read-only mount the templates have since 0.6.0 (see docs/security-model.md)');
    }
    return { rows, mounts: mounts.map(([, text]) => text), warnings, notes };
}

/**
 * Where a sandbox made without --workspace has its own .devcontainer writable inside: its folder is
 * bind-mounted read-write (the workspace) and nothing read-only covers FOLDER/.devcontainer. Null when
 * protected, for --workspace sandboxes (their config stays outside), or when there's no such config.
 */
export function writableConfig(info: PodmanInfo, folder: string, exists: (path: string) => boolean = existsSync): string | null {
    if (!folder || exists(join(folder, SETTINGS)) || !exists(join(folder, '.devcontainer'))) return null;
    const mounts = (info.Mounts ?? []).filter((m) => m.Type === 'bind');
    const workspace = mounts.find((m) => m.Source === folder && m.RW);
    if (!workspace) return null;
    const config = join(folder, '.devcontainer');
    return mounts.some((m) => m.Source === config && !m.RW) ? null : join(workspace.Destination, '.devcontainer');
}

/** Left-aligned columns, two spaces apart. */
export function table(rows: string[][]): string {
    const widths = rows[0].map((_, i) => Math.max(...rows.map((row) => (row[i] ?? '').length)));
    return rows.map((row) => row.map((cell, i) => (i < row.length - 1 ? cell.padEnd(widths[i]) : cell)).join('  '))
        .join('\n');
}
