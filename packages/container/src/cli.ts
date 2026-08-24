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
  operon pr <owner/repo> [dir] --title <t> --body <b>
                                         propose a change to an allowlisted repo: the
                                         files in dir (default "pr") are added/updated
                                         on a branch and a pull request is opened. Swept
                                         like publish. No git and no token run here; a
                                         Gatekeeper does the commit and PR via the API.
                                         For an EXISTING file, put the full new content
                                         at the same path; fetch its current form off
                                         the public repo yourself first.

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
    case "pr": {
      const [repo, dir] = positionals(rest);
      const title = flagValue(rest, "--title");
      const body = flagValue(rest, "--body");
      if (!repo || !repo.includes("/") || !title || !body) {
        throw new CliUsageError(
          "usage: operon pr <owner/repo> [dir] --title <t> --body <b>"
        );
      }
      return { path: "/pr", payload: { repo, dir: dir ?? "pr", title, body } };
    }
    default:
      throw new CliUsageError(`unknown command "${command}"; run operon --help`);
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
