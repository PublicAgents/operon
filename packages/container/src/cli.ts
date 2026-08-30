#!/usr/bin/env node
/**
 * `operon`: the wake's door handle. A thin client for the porch (the
 * loopback server the entrypoint runs); it holds no credentials and knows
 * no endpoints beyond OPERON_PORCH. Run `operon --help` to see which
 * doors are live this wake.
 */

const HELP = `operon: the doors out of this wake

  operon capabilities                    which doors are live, your hosts, PR targets
  operon pull                            fetch new email, X DMs, and operator
                                         messages that arrived since wake start
                                         (or your last pull) into inbox/ and
                                         operator/channel.md; safe to repeat
  operon notify <text...>                message the operator
  operon publish [dir] --host <host>     publish a directory of static files to an
                                         assigned host ("@" is the zone apex);
                                         dir defaults to "site". Swept for secrets
                                         before anything leaves the container.
  operon email --to <addr> --subject <s> --body <b>
                                         (or pipe the body on stdin and omit
                                         --body; --body - also reads stdin)
                                         send an email (disclosed as an AI agent,
                                         rate-limited; a first email to a new
                                         recipient is held for the operator). Your
                                         inbound mail is in inbox/ at wake
                                         start and on every operon pull.
  operon email original <id>             the stored, UNREDACTED original of an
                                         inbound message (id = the 8-char prefix
                                         in the inbox file's name): use it when a
                                         line was withheld at delivery and you
                                         need what it carried, e.g. a sign-up or
                                         verification link. Never save the
                                         credential parts to your repo.
  operon channel original <id>           the stored, unredacted original of one
                                         operator-channel entry (id = the [#id]
                                         on its header line in
                                         operator/channel.md), for when a
                                         transcript line was withheld

Till doors (sell your work; spec: your prices, the operator's ceilings;
custody and recipients are the operator's alone):

  operon till offer <host> <path> --price <p> --currency <c> --description <d>
                                         put a price on a path of one of YOUR
                                         hosts; visitors and agents then pay by
                                         MPP before it serves. Update by
                                         re-offering the same host+path.
  operon till retire <host> <path>       make a path free again
  operon till sales                      your offers and ledgered receipts
  operon pay <url> --max <amount> --reason <r>
                                         fetch a paid resource: free content comes
                                         straight back; a payable challenge within
                                         your --max and the colony caps is PAID by
                                         the spend Gatekeeper (you never hold a
                                         key); a FIRST payment to a new merchant is
                                         held for the operator, and so is an
                                         above-cap payment (approval mints a
                                         one-time allowance; re-run the same pay
                                         to settle). Ambiguous outcomes
                                         freeze and are never retried by you.

Vault doors (your own secret store, for anything that must survive
between wakes but may NEVER sit in your repo, hard rule 7). A vaulted
value is folded into the secret sweep: it cannot appear in your repo, a
publish, a PR, or an email. Retrieve it when you need to USE it:

  operon pay proposals                   your pending holds and unspent
                                         allowances, across wakes
  operon vault set <label> --value <v>   store or update a secret by label (or
                                         pipe the value on stdin and omit
                                         --value). Do not ALSO write it to a
                                         repo file; the presleep gate blocks
                                         any push containing it.
  operon vault get <label>               retrieve a secret's value
  operon vault list                      your labels and timestamps (no values)
  operon vault delete <label>            remove a secret permanently

X doors (post to YOUR OWN X account; the policy is enforced by the
Gatekeeper, not by trust: the account is labeled automated with an AI
disclosure, volume is capped (default 4/day, 20 min apart), duplicates
and mention/hashtag spam are refused, and every post is ledgered and
shown to the operator. Low volume, value first):

  operon x post --text <t>               post to your own account (or pipe the
                                         text on stdin and omit --text); answers
                                         with the live URL
  operon x posts                         your recent posts (cross-wake memory)
  operon x me                            your own profile as X sees it (bio,
                                         follower counts, pinned_tweet_id);
                                         also a credential self-check
  operon web open [name]                 print the CDP endpoint for a named
                                         browser session (state persists across
                                         wakes); the browser MCP server is
                                         already pointed at "default"
  operon web sessions                    your sessions and where they are
                                         logged in (domains, never values)
  operon web close <name>                end the live session (state is kept)
  operon web password <name> --domains <a.com,b.com>
                                         mint a password DOOR-SIDE for those
                                         domains; you get a placeholder to type,
                                         never the value, and the relay swaps it
                                         in only on a bound origin
  operon x dm <@handle> --text <t>       DM someone who has DM'd YOU first (or
                                         pipe the text on stdin). Reply-only by
                                         construction: a cold DM is not a
                                         refusal, the recipient simply does not
                                         resolve. Inbound DMs arrive in inbox/
                                         beside your mail, at wake start and
                                         on every operon pull.

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
    case "pull":
      return { path: "/pull", payload: {} };

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
      if (rest[0] === "original") {
        const id = positionals(rest.slice(1))[0];
        if (!id || id.length < 8) {
          throw new CliUsageError("usage: operon email original <message id or its 8-char prefix>");
        }
        return { path: "/email/original", payload: { id } };
      }
      const to = flagValue(rest, "--to");
      const subject = flagValue(rest, "--subject");
      const body = flagValue(rest, "--body");
      if (!to || !to.includes("@") || !subject) {
        throw new CliUsageError(
          "usage: operon email --to <addr> --subject <s> --body <b> (or pipe the body on stdin)"
        );
      }
      // --body omitted (or the conventional "-"): main() reads the body
      // from stdin. A literal one-character dash is never a real email.
      return { path: "/email", payload: { to, subject, ...(body && body !== "-" ? { text: body } : {}) } };
    }
    case "github":
      return parseGithub(rest);
    case "till":
      return parseTill(rest);
    case "vault":
      return parseVault(rest);
    case "x":
      return parseX(rest);
    case "web":
      return parseWeb(rest);
    case "channel": {
      const [sub, idRaw] = positionals(rest);
      const id = Number(idRaw);
      if (sub !== "original" || !idRaw || !Number.isInteger(id) || id <= 0) {
        throw new CliUsageError("usage: operon channel original <id> (the [#id] on the entry's header line)");
      }
      return { path: "/channel/original", payload: { id } };
    }
    case "pay": {
      if (rest[0] === "proposals") {
        return { path: "/pay/proposals", payload: {} };
      }
      const [url] = positionals(rest);
      const max = flagValue(rest, "--max");
      const reason = flagValue(rest, "--reason");
      if (!url || !url.startsWith("https://") || !max || !reason) {
        throw new CliUsageError(
          "usage: operon pay <https-url> --max <amount> --reason <r> (or: operon pay proposals)"
        );
      }
      return { path: "/pay", payload: { url, maxAmount: max, reason } };
    }
    default:
      throw new CliUsageError(`unknown command "${command}"; run operon --help`);
  }
}

function parseTill(args: string[]): CliCall {
  const [sub, ...rest] = args;
  switch (sub) {
    case "offer": {
      const [host, path] = positionals(rest);
      const price = flagValue(rest, "--price");
      const currency = flagValue(rest, "--currency");
      const description = flagValue(rest, "--description");
      if (!host || !path || !path.startsWith("/") || !price || !currency || !description) {
        throw new CliUsageError(
          "usage: operon till offer <host> <path> --price <p> --currency <c> --description <d>"
        );
      }
      return { path: "/till/offer", payload: { host, path, price, currency, description } };
    }
    case "retire": {
      const [host, path] = positionals(rest);
      if (!host || !path || !path.startsWith("/")) {
        throw new CliUsageError("usage: operon till retire <host> <path>");
      }
      return { path: "/till/retire", payload: { host, path } };
    }
    case "sales":
      return { path: "/till/sales", payload: {} };
    default:
      throw new CliUsageError("unknown till subcommand; expected one of: offer, retire, sales");
  }
}

function parseVault(args: string[]): CliCall {
  const [sub, ...rest] = args;
  const label = positionals(rest)[0];
  switch (sub) {
    case "set": {
      // --value may be omitted: main() then reads the value from stdin,
      // which keeps the secret off the process argv.
      const value = flagValue(rest, "--value");
      if (!label) {
        throw new CliUsageError(
          "usage: operon vault set <label> --value <v> (or pipe the value on stdin)"
        );
      }
      return { path: "/vault/set", payload: { label, ...(value !== undefined ? { value } : {}) } };
    }
    case "get":
      if (!label) throw new CliUsageError("usage: operon vault get <label>");
      return { path: "/vault/get", payload: { label } };
    case "list":
      return { path: "/vault/list", payload: {} };
    case "delete":
      if (!label) throw new CliUsageError("usage: operon vault delete <label>");
      return { path: "/vault/delete", payload: { label } };
    default:
      throw new CliUsageError("unknown vault subcommand; expected one of: set, get, list, delete");
  }
}

function parseWeb(args: string[]): CliCall {
  const [sub, ...rest] = args;
  const NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
  switch (sub) {
    case undefined:
    case "open": {
      const name = positionals(rest)[0] ?? "default";
      if (!NAME.test(name)) throw new CliUsageError("usage: operon web open [name]");
      // LOCAL: prints the CDP endpoint a browser client dials; no POST.
      return { path: `/web/session/${name}`, payload: { local: true } };
    }
    case "sessions":
      return { path: "/web/sessions", payload: {} };
    case "close": {
      const name = positionals(rest)[0];
      if (!name || !NAME.test(name)) throw new CliUsageError("usage: operon web close <name>");
      return { path: "/web/close", payload: { name } };
    }
    case "password": {
      const [name] = positionals(rest);
      const domains = flagValue(rest, "--domains");
      if (!name || !NAME.test(name) || !domains) {
        throw new CliUsageError(
          "usage: operon web password <name> --domains <a.com,b.com> (the value is minted door-side; you get a placeholder)"
        );
      }
      return {
        path: "/web/password",
        payload: { name, domains: domains.split(",").map(d => d.trim()).filter(Boolean) }
      };
    }
    default:
      throw new CliUsageError("unknown web subcommand; expected one of: open, sessions, close, password");
  }
}

function parseX(args: string[]): CliCall {
  const [sub, ...rest] = args;
  switch (sub) {
    case "post": {
      // --text may be omitted: main() then reads the text from stdin.
      const text = flagValue(rest, "--text");
      return { path: "/x/post", payload: { ...(text !== undefined ? { text } : {}) } };
    }
    case "posts":
      return { path: "/x/posts", payload: {} };
    case "me":
      return { path: "/x/me", payload: {} };
    case "dm": {
      const [to] = positionals(rest);
      const text = flagValue(rest, "--text");
      if (!to) throw new CliUsageError("usage: operon x dm <@handle> --text <t> (or pipe the text on stdin)");
      return { path: "/x/dm", payload: { to, ...(text !== undefined ? { text } : {}) } };
    }
    default:
      throw new CliUsageError("unknown x subcommand; expected one of: post, posts, dm, me");
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
    // The living guide: rendered by the porch from THIS wake's real
    // configuration (skills.ts), so it updates with every chassis
    // deploy and marks doors that are not wired. The static text below
    // is only the no-porch fallback.
    const porchUrl = process.env.OPERON_PORCH;
    if (porchUrl) {
      try {
        const response = await fetch(`${porchUrl}/help`, {
          headers: { "x-operon-porch": "1" }
        });
        const body = (await response.json()) as { help?: string };
        if (response.ok && typeof body.help === "string") {
          console.log(body.help);
          return 0;
        }
      } catch {
        /* fall through to the static fallback */
      }
    }
    console.log(HELP);
    return 0;
  }

  const porch = process.env.OPERON_PORCH;
  if (!porch) {
    console.error("no porch: OPERON_PORCH is not set, so no doors are wired this wake");
    return 3;
  }

  // vault set / x post without the inline flag: the payload text comes
  // from stdin (kept off argv; posts keep their formatting).
  const stdinField =
    call.path === "/vault/set" && call.payload.value === undefined
      ? { name: "value", usage: "vault set: pass --value <v> or pipe the value on stdin", trim: true }
      : call.path === "/x/post" && call.payload.text === undefined
        ? { name: "text", usage: "x post: pass --text <t> or pipe the text on stdin", trim: false }
        : call.path === "/x/dm" && call.payload.text === undefined
          ? { name: "text", usage: "x dm: pass --text <t> or pipe the text on stdin", trim: false }
          : call.path === "/email" && call.payload.text === undefined
            ? { name: "text", usage: "email: pass --body <b> or pipe the body on stdin", trim: false }
            : null;
  if (stdinField) {
    if (process.stdin.isTTY) {
      console.error(stdinField.usage);
      return 2;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
    let value = Buffer.concat(chunks).toString("utf8");
    value = stdinField.trim ? value.replace(/\r?\n$/, "") : value.replace(/\n$/, "");
    if (!value) {
      console.error(`${stdinField.name} was empty on stdin`);
      return 2;
    }
    call.payload[stdinField.name] = value;
  }

  // The web door is a WebSocket the mind's browser client dials, not a
  // porch POST: print the endpoint + the CSRF header and return.
  if (call.payload.local === true && call.path.startsWith("/web/session/")) {
    const ws = porch.replace(/^http/, "ws") + call.path;
    console.log(
      JSON.stringify(
        {
          ok: true,
          cdpEndpoint: ws,
          wsHeaders: { "x-operon-porch": "1" },
          note: "point chrome-devtools-mcp --wsEndpoint here (with --wsHeaders), or connectOverCDP in a script"
        },
        null,
        2
      )
    );
    return 0;
  }

  const isGet = call.path === "/capabilities";
  const response = await fetch(`${porch}${call.path}`, {
    method: isGet ? "GET" : "POST",
    headers: {
      // The porch's browser boundary: see porch.ts.
      "x-operon-porch": "1",
      ...(isGet ? {} : { "content-type": "application/json" })
    },
    ...(isGet ? {} : { body: JSON.stringify(call.payload) })
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
