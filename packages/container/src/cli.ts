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
  operon clone <owner/repo>              clone an allowlisted repo for a pull request;
                                         prints the path to work in
  operon pr <owner/repo> --title <t> --body <b>
                                         push the current feature branch of that clone
                                         to the machine user's fork and open a PR

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
      const positional = rest.filter(
        (arg, i) => !arg.startsWith("--") && rest[i - 1] !== "--host"
      );
      return { path: "/publish", payload: { dir: positional[0] ?? "site", host } };
    }
    case "clone": {
      const repo = rest[0];
      if (!repo || !repo.includes("/")) throw new CliUsageError("usage: operon clone <owner/repo>");
      return { path: "/clone", payload: { repo } };
    }
    case "pr": {
      const repo = rest[0];
      const title = flagValue(rest, "--title");
      const body = flagValue(rest, "--body");
      if (!repo || !repo.includes("/") || !title || !body) {
        throw new CliUsageError("usage: operon pr <owner/repo> --title <t> --body <b>");
      }
      return { path: "/pr", payload: { repo, title, body } };
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
      : {
          headers: { "content-type": "application/json" },
          body: JSON.stringify(call.payload)
        })
  });
  const body = (await response.json()) as Record<string, unknown>;
  console.log(JSON.stringify(body, null, 2));
  return response.ok && body.ok !== false ? 0 : 1;
}

// Only run as a program when invoked directly, so tests can import parseArgs.
if (process.argv[1]?.endsWith("cli.js")) {
  main()
    .then(code => process.exit(code))
    .catch(error => {
      console.error(`operon failed: ${String(error)}`);
      process.exit(1);
    });
}
