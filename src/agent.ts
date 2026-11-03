// The sandbox's agent as a Feature of its own, next to the config rather than in it (lab 47): a local
// Feature in .devcontainer/agent/NAME/, passed to every devcontainer command that builds or reads the
// config with --additional-features. devcontainer.json doesn't name it, so switching agents is
// swapping that folder, and a user's own config stays as they wrote it. The folder is the record:
// .devcontainer is read-only inside the sandbox, so the agent can't change what the next build runs.
// The Dev Containers CLI takes a local Feature only from inside .devcontainer (not by absolute path).
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { SandboxError } from './devcontainer.js';

/** Where the agent's Feature folder goes, inside .devcontainer. */
export const AGENT_DIR = 'agent';

/**
 * The agent Feature of the sandbox in config folder DIR: its folder's name (e.g. codex), or null when
 * it has none. More than one is refused: a sandbox has one agent.
 */
export function agentOf(dir: string): string | null {
    const root = join(dir, '.devcontainer', AGENT_DIR);
    if (!existsSync(root)) return null;
    const agents = readdirSync(root, { withFileTypes: true })
        .filter((e) => e.isDirectory() && existsSync(join(root, e.name, 'devcontainer-feature.json')))
        .map((e) => e.name).sort();
    if (agents.length > 1) {
        throw new SandboxError(`${root} has more than one agent (${agents.join(', ')}): a sandbox has one; `
            + 'remove the others');
    }
    return agents[0] ?? null;
}

/** The devcontainer options that add DIR's agent Feature: [] without one. */
export function agentArgs(dir: string): string[] {
    const agent = agentOf(dir);
    return agent ? ['--additional-features', JSON.stringify({ [`./${AGENT_DIR}/${agent}`]: {} })] : [];
}
