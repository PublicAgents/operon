import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Hardened credentialed git invocations. The threat model: the mind
 * session runs as a different, unprivileged user in the same container,
 * and clones are session-writable, so
 *
 *  - the token must never appear on argv (/proc/<pid>/cmdline is
 *    world-readable): it travels in the git child's environment, read by
 *    an inline credential helper, and process environments are readable
 *    only by the owning uid (the entrypoint's, not the session's);
 *  - the token must never land on disk (no embedding in remote URLs, so
 *    nothing in .git/config carries it);
 *  - nothing the repo can configure may execute during our git runs:
 *    hooks are pointed at an empty directory and pushes use --no-verify,
 *    repo-defined credential helpers are cleared before ours is added,
 *    and fsmonitor is forced off. -c overrides take precedence over
 *    repo-level configuration, which is the property this relies on.
 */

const TOKEN_ENV = "OPERON_GIT_ACCESS_TOKEN";

let emptyHooksDir: string | null = null;
function ensureEmptyHooksDir(): string {
  if (!emptyHooksDir) {
    emptyHooksDir = join(tmpdir(), "operon-empty-hooks");
    mkdirSync(emptyHooksDir, { recursive: true });
  }
  return emptyHooksDir;
}

/** The only remote host and scheme the token is ever handed to. */
const GITHUB_ORIGIN = "https://github.com";

/**
 * Config flags prepended to every credentialed git command. Beyond
 * disabling hooks/fsmonitor, these defend the ROOT-run push against a
 * .git/config the unprivileged mind can rewrite:
 *
 *  - the credential helper is SCOPED to https://github.com, so even if the
 *    mind rewrites a remote or adds a url.<evil>.insteadOf rule, the token
 *    is never handed to any other host (that push just fails, unauthed);
 *  - SSH and file transports are refused and core.sshCommand is forced to
 *    a no-op, so a rewritten ssh:// remote cannot execute a command as
 *    root; only https/git remain;
 *  - -c overrides take precedence over repo-level config, which is what
 *    makes these hold against a hostile local config.
 *
 * Callers still push to an EXPLICIT github.com URL rather than a remote
 * name, so the transport is not read from the mind-owned remote at all.
 */
export function hardenedGitFlags(): string[] {
  const helper = `!f() { echo username=x-access-token; echo "password=$${TOKEN_ENV}"; }; f`;
  return [
    "-c",
    "credential.helper=",
    "-c",
    `credential.${GITHUB_ORIGIN}.helper=`,
    "-c",
    `credential.${GITHUB_ORIGIN}.helper=${helper}`,
    "-c",
    "credential.useHttpPath=false",
    "-c",
    `core.hooksPath=${ensureEmptyHooksDir()}`,
    "-c",
    "core.fsmonitor=false",
    "-c",
    "core.sshCommand=/bin/false",
    "-c",
    "protocol.ssh.allow=never",
    "-c",
    "protocol.file.allow=never"
  ];
}

/** The explicit, trusted push/clone URL for a github "owner/repo". */
export function githubRepoUrl(repo: string): string {
  return `${GITHUB_ORIGIN}/${repo}.git`;
}


/** Environment for a credentialed git child. */
export function gitCredentialEnv(
  base: Record<string, string>,
  token: string
): Record<string, string> {
  return {
    ...base,
    [TOKEN_ENV]: token,
    GIT_TERMINAL_PROMPT: "0",
    // The entrypoint may run as root over session-owned worktrees.
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "safe.directory",
    GIT_CONFIG_VALUE_0: "*"
  };
}
