#!/usr/bin/env node
/**
 * `operon`: the wake's door handle. A thin client for the porch (the
 * loopback server the entrypoint runs); it holds no credentials and knows
 * no endpoints beyond OPERON_PORCH. Run `operon --help` to see which
 * doors are live this wake.
 */

const HELP = `operon: the doors out of this wake

  operon capabilities                    which doors are live, your hosts, PR targets
  operon notify <text...>                message the operator (Telegram)
  operon publish [dir] --host <host>     publish a directory of static files to an
                                         assigned host ("@" is the zone apex);
                                         dir defaults to "site". Swept for secrets
                                         before anything leaves the container.
  operon email --to <addr> --subject <s> --body <b>
                                         send an email (disclosed as an AI agent,
                                         rate-limited; a first email to a new
                                         recipient is held for the operator). Your
                                         inbound mail is in inbox/ each wake.

GitHub doors (a Gatekeeper holds the credential and does the writes; you
submit data). Your account authored a thing = you may update it anywhere;
allowlisted repos = you may read and comment on anything in them.

  operon github status                   two lists: your own PRs/issues with their
                                         state and latest (review) comments, and
                                         recently active items by OTHERS in the
                                         allowlisted repos, so new issues and
                                         review feedback reach you each wake
  operon github thread <owner/repo> <n>  the full conversation on one PR/issue:
                                         body, comments, reviews, inline review
                                         comments (with their ids, for replies)
  operon github comment <owner/repo> <n> --body <text> | --body-file <f> [--reply-to <id>]
                                         comment on a PR/issue (yours anywhere, or
                                         any in an allowlisted repo); --reply-to
                                         answers inside an inline review thread
  operon github pr <owner/repo> [dir] --title <t> --body <b> [--submodule <path>=<sha>]
                                         propose a change to an allowlisted repo: the
                                         files in dir (default "pr") are added/updated
                                         on a branch and a pull request is opened.
                                         For an EXISTING file, put the full new content
                                         at the same path; fetch its current form off
                                         the public repo yourself first.
                                         --submodule advances a submodule pointer to a
                                         full 40-hex commit sha (e.g. operon=<sha>); a
                                         bump-only PR needs no dir.
  operon github push <owner/repo> <n> [dir] --message <m>
                                         push follow-up files to YOUR OWN open PR's
                                         branch (answer review feedback with commits);
                                         dir defaults to "pr", swept like publish
  operon github update <owner/repo> <n> [--title <t>] [--body-file <f>] [--state open|closed]
                                         edit YOUR OWN PR/issue title or body, or
                                         close/reopen it
  operon github issue <owner/repo> <bodyfile> --title <t>
                                         open an issue on an allowlisted repo; the
                                         body is read from bodyfile (a markdown file
                                         in your repo). Swept before it leaves.

Doors answer with named errors when something is wrong; an error names
what to fix. A door that is not wired yet answers *_not_wired.`;

interface CliCall {
  path: string;
  payload: Record<string, unknown>;
}

export class CliUsageError extends Error {
  override name = "CliUsageError";
}

function flagValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index === -1 || index + 1 >= args.length) return undefined;
  return args[index + 1];
}

/** Positional args are those not starting with -- and not consumed by a flag. */
function positionals(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith("--")) {
      i++; // skip the flag's value
      continue;
    }
    out.push(args[i]);
  }
  return out;
}

export function parseArgs(argv: string[]): CliCall | "help" {
  const [command, ...rest] = argv;
  if (!command || command === "--help" || command === "help") return "help";
  switch (command) {
    case "capabilities":
      return { path: "/capabilities", payload: {} };

    case "notify": {
      const text = rest.join(" ").trim();
      if (!text) throw new CliUsageError("usage: operon notify <text...>");
      return { path: "/notify", payload: { text } };
    }
    case "publish": {
      const host = flagValue(rest, "--host");
      if (!host) throw new CliUsageError("usage: operon publish [dir] --host <host>");
      return { path: "/publish", payload: { dir: positionals(rest)[0] ?? "site", host } };
    }
    case "email": {
      const to = flagValue(rest, "--to");
      const subject = flagValue(rest, "--subject");
      const body = flagValue(rest, "--body");
      if (!to || !to.includes("@") || !subject || !body) {
        throw new CliUsageError("usage: operon email --to <addr> --subject <s> --body <b>");
      }
      return { path: "/email", payload: { to, subject, text: body } };
    }
    case "github":
      return parseGithub(rest);
    default:
      throw new CliUsageError(`unknown command "${command}"; run operon --help`);
  }
}

function parseGithub(args: string[]): CliCall {
  const [sub, ...rest] = args;
  const intNumber = (raw: string | undefined): number => {
    const n = Number(raw);
    if (!raw || !Number.isInteger(n) || n <= 0) {
      throw new CliUsageError("expected a PR/issue number");
    }
    return n;
  };
  switch (sub) {
    case "status":
      return { path: "/github/status", payload: {} };
    case "thread": {
      const [repo, num] = positionals(rest);
      if (!repo || !repo.includes("/")) {
        throw new CliUsageError("usage: operon github thread <owner/repo> <number>");
      }
      return { path: "/github/thread", payload: { repo, number: intNumber(num) } };
    }
    case "comment": {
      const [repo, num] = positionals(rest);
      const body = flagValue(rest, "--body");
      const bodyFile = flagValue(rest, "--body-file");
      const replyTo = flagValue(rest, "--reply-to");
      if (!repo || !repo.includes("/") || (!body && !bodyFile)) {
        throw new CliUsageError(
          "usage: operon github comment <owner/repo> <number> --body <text> | --body-file <f> [--reply-to <id>]"
        );
      }
      return {
        path: "/github/comment",
        payload: {
          repo,
          number: intNumber(num),
          ...(body ? { body } : {}),
          ...(bodyFile ? { bodyFile } : {}),
          ...(replyTo ? { replyTo: intNumber(replyTo) } : {})
        }
      };
    }
    case "pr": {
      const [repo, dir] = positionals(rest);
      const title = flagValue(rest, "--title");
      const body = flagValue(rest, "--body");
      const submoduleFlag = flagValue(rest, "--submodule");
      if (!repo || !repo.includes("/") || !title || !body) {
        throw new CliUsageError(
          "usage: operon github pr <owner/repo> [dir] --title <t> --body <b> [--submodule <path>=<sha>]"
        );
      }
      let submodules: Array<{ path: string; sha: string }> | undefined;
      if (submoduleFlag !== undefined) {
        const match = /^([^=]+)=([0-9a-f]{40})$/.exec(submoduleFlag);
        if (!match) {
          throw new CliUsageError("--submodule expects <path>=<40-hex commit sha>");
        }
        submodules = [{ path: match[1], sha: match[2] }];
      }
      return {
        path: "/github/pr",
        payload: {
          repo,
          // A bump-only PR carries no dir; the porch skips file collection.
          ...(dir !== undefined || !submodules ? { dir: dir ?? "pr" } : {}),
          title,
          body,
          ...(submodules ? { submodules } : {})
        }
      };
    }
    case "push": {
      const [repo, num, dir] = positionals(rest);
      const message = flagValue(rest, "--message");
      if (!repo || !repo.includes("/") || !message) {
        throw new CliUsageError(
          "usage: operon github push <owner/repo> <number> [dir] --message <m>"
        );
      }
      return {
        path: "/github/push",
        payload: { repo, number: intNumber(num), dir: dir ?? "pr", message }
      };
    }
    case "update": {
      const [repo, num] = positionals(rest);
      const title = flagValue(rest, "--title");
      const bodyFile = flagValue(rest, "--body-file");
      const state = flagValue(rest, "--state");
      if (!repo || !repo.includes("/") || (!title && !bodyFile && !state)) {
        throw new CliUsageError(
          "usage: operon github update <owner/repo> <number> [--title <t>] [--body-file <f>] [--state open|closed]"
        );
      }
      if (state && state !== "open" && state !== "closed") {
        throw new CliUsageError("--state must be open or closed");
      }
      return {
        path: "/github/update",
        payload: {
          repo,
          number: intNumber(num),
          ...(title ? { title } : {}),
          ...(bodyFile ? { bodyFile } : {}),
          ...(state ? { state } : {})
        }
      };
    }
    case "issue": {
      const [repo, bodyFile] = positionals(rest);
      const title = flagValue(rest, "--title");
      if (!repo || !repo.includes("/") || !bodyFile || !title) {
        throw new CliUsageError("usage: operon github issue <owner/repo> <bodyfile> --title <t>");
      }
      return { path: "/github/issue", payload: { repo, bodyFile, title } };
    }
    default:
      throw new CliUsageError(
        'unknown github subcommand; expected one of: status, thread, comment, pr, push, update, issue'
      );
  }
}

async function main(): Promise<number> {
  let call: CliCall | "help";
  try {
    call = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(String((error as Error).message));
    return 2;
  }
  if (call === "help") {
    console.log(HELP);
    return 0;
  }

  const porch = process.env.OPERON_PORCH;
  if (!porch) {
    console.error("no porch: OPERON_PORCH is not set, so no doors are wired this wake");
    return 3;
  }

  const isGet = call.path === "/capabilities";
  const response = await fetch(`${porch}${call.path}`, {
    method: isGet ? "GET" : "POST",
    ...(isGet
      ? {}
      : { headers: { "content-type": "application/json" }, body: JSON.stringify(call.payload) })
  });
  const body = (await response.json()) as Record<string, unknown>;
  console.log(JSON.stringify(body, null, 2));
  return response.ok && body.ok !== false ? 0 : 1;
}

if (process.argv[1]?.endsWith("cli.js")) {
  main()
    .then(code => process.exit(code))
    .catch(error => {
      console.error(`operon failed: ${String(error)}`);
      process.exit(1);
    });
}
