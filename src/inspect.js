// sandbox inspect: the podman command that created a sandbox, and what it runs with.
// Pure functions over `podman container inspect` output; cli.js does the podman calls.

const SAFE = /^[A-Za-z0-9_@%+=:,./-]+$/;

/** ARG quoted for the shell: bare when safe, else '…'; $'…' (bash, zsh) when it has control characters. */
export function shellQuote(arg) {
    if (SAFE.test(arg)) return arg;
    if (/[\x00-\x1f\x7f]/.test(arg)) {
        const escaped = arg.replace(/[\\']/g, '\\$&').replace(/\n/g, '\\n').replace(/\t/g, '\\t')
            .replace(/[\x00-\x1f\x7f]/g, (c) => `\\x${c.charCodeAt(0).toString(16).padStart(2, '0')}`);
        return `$'${escaped}'`;
    }
    return `'${arg.replace(/'/g, `'\\''`)}'`;
}

/** An image reference as the Dev Containers CLI passes it: without localhost/ and :latest. */
const bare = (image) => image.replace(/^localhost\//, '').replace(/:latest$/, '');

/**
 * Split a `podman run` command line into [program, subcommand], the options as [flag] or
 * [flag, value], the image, and the command after it. IMAGE (from inspect) is where the options
 * end: a flag followed by a word that isn't the image takes it as its value. Null when the image
 * isn't found.
 */
export function splitCommand(argv, image) {
    const want = bare(image);
    const options = [];
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
export function formatCommand(argv, image) {
    const split = splitCommand(argv, image);
    const lines = split
        ? [split.head, ...split.options, [split.image, ...split.args]]
        : [argv.slice(0, 2), ...argv.slice(2).map((arg) => [arg])];
    return lines.map((words) => words.map(shellQuote).join(' ')).join(' \\\n    ');
}

/** Every value given to FLAG, as --flag=value or --flag value. */
export function optionValues(options, flag) {
    const values = [];
    for (const [name, value] of options) {
        if (name === flag && value !== undefined) values.push(value);
        else if (name.startsWith(`${flag}=`)) values.push(name.slice(flag.length + 1));
    }
    return values;
}

/** CapBnd, NoNewPrivs and Seccomp from a /proc/PID/status text. */
export function parseStatus(text) {
    const status = {};
    for (const line of text.split('\n')) {
        const m = /^(CapBnd|NoNewPrivs|Seccomp):\s*(\S+)/.exec(line);
        if (m) status[m[1]] = m[2];
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
export function parseVscodeProbe(text) {
    const probe = { server: 0, sockets: [], helpers: [] };
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

/** What an agent's answer means, for people. ATTACHED: another socket answers now. */
function agentState(agent, attached) {
    const keys = /^keys (\d+)$/.exec(agent);
    if (keys) return `answers now: ${keys[1]} key${keys[1] === '1' ? '' : 's'}`;
    if (agent === 'dead') return attached ? 'not answering: from an earlier attach' : 'not answering: VS Code not attached';
    return agent === 'refused' ? 'answers, but refused the key list' : 'not checked';
}

// Host sockets that give a container more than files: [test on the mount source, what it means, warn?].
const HOST_SOCKETS = [
    [/(keyring\/ssh|ssh-agent|\/agent\.\d+|\/S\.gpg-agent(\.ssh)?)$/,
        'the host\'s SSH or GPG agent: any process inside can use your keys', true],
    [/(podman|docker)\.sock$/, 'a Podman or Docker API socket: control of containers outside this one', true],
    [/^\/tmp\/\.X11-unix/, 'the X11 display: any X client can read the input of the other windows', true],
    [/(\/bus|dbus\/system_bus_socket)$/, 'a D-Bus socket: the desktop\'s or the system\'s services', true],
    [/\/pipewire-\d+$/, 'PipeWire: audio and screen capture', true],
    [/\/wayland-\d+$/, 'the Wayland display: windows on your desktop, and the clipboard while focused', false],
];

/** KEY=VALUE pairs of a --mount value. */
function mountFields(spec) {
    return Object.fromEntries(spec.split(',').map((kv) => [kv.split('=')[0], kv.split('=').slice(1).join('=')]));
}

const capName = (cap) => cap.replace(/^CAP_/, '').toLowerCase();

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
export function audit(info, {
    status = null, internal = {}, uncovered = [], sandbox = true, vscode = null, configWritable = null,
} = {}) {
    const host = info.HostConfig ?? {};
    const split = splitCommand(info.Config?.CreateCommand ?? [], info.ImageName ?? '');
    const options = split?.options ?? [];
    // Inspect's own fields where it has them; the command line for what it leaves out (unmask, devices).
    const securityOpts = host.SecurityOpt ?? [];
    const unmasked = [...new Set([...securityOpts, ...optionValues(options, '--security-opt')]
        .filter((o) => o.startsWith('unmask=')).map((o) => o.slice(7)))];
    const devices = [...new Set([...(host.Devices ?? []).map((d) => d.PathOnHost),
        ...optionValues(options, '--device').map((d) => d.split(':')[0])])];
    const nested = devices.includes('/dev/net/tun');
    const rows = [];
    const warnings = [];
    const notes = [];
    const unhardened = [];

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

    const mounts = [];
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
