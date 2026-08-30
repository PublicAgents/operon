import type { WakeConfig } from "./config.js";

/**
 * The living CLI guide (served by the porch at GET /help, printed by
 * `operon --help`). One source, rendered FRESH each call from the
 * wake's real configuration, so the guidance the mind reads can never
 * drift from what is wired: it updates with every chassis deploy and
 * marks doors that are not live this wake. Task-first on purpose: the
 * last-wake failure mode was a mind that knew the flags but not the
 * moves (it waited a wake for a verification mail that one `operon
 * pull` would have fetched).
 */

function mark(live: unknown): string {
  return live ? "" : "   [NOT WIRED this wake]";
}

export function renderSkills(
  config: WakeConfig,
  caps: Record<string, unknown>
): string {
  void config; // reserved: future per-colony guidance (hosts, PR targets)
  return `operon: the doors out of this wake (fresh guidance; re-run any time)

WHEN TO REACH FOR WHAT
  Something should have arrived (a reply, a verification link, a DM,
    an operator answer)? -> operon pull. Mail, X DMs, and operator
    messages are delivered at wake start AND ON DEMAND: pull fetches
    whatever arrived SINCE, mid-wake, into inbox/ and
    operator/channel.md. A verification email sent two minutes ago is
    one pull away, not one wake away. Safe to repeat; nothing is lost
    or double-acked.
  A delivered line was redacted (sign-up link, code)? -> operon email
    original <id> / operon channel original <id>.
  Tell the operator something or ask a question -> operon notify (they
    may answer MID-WAKE: pull before you sleep if you asked).
  Browse or sign in somewhere -> the browser MCP tools (already
    connected to session "default"); operon web password mints a
    door-side password you never see; operon web sessions shows where
    you are logged in.
  Ship pages -> operon publish. Sell a path -> operon till offer. Buy
    -> operon pay. Post -> operon x post. Secrets that must survive
    wakes -> operon vault (never the repo).
  Not sure what is wired right now -> operon capabilities.

CHECKING FOR NEW INPUT (mid-wake)
  operon pull                            fetch new email, X DMs, and operator
                                         messages since wake start (or your
                                         last pull); answers with counts${mark(caps.email || caps.notify || caps.x)}

MESSAGING AND MAIL
  operon notify <text...>                message the operator${mark(caps.notify)}
  operon email --to <addr> --subject <s> --body <b>
                                         (long body? pipe it on stdin and omit
                                         --body; a literal --body - also reads
                                         stdin, never sends a dash)
                                         send an email (disclosed as an AI
                                         agent, rate-limited; a first email to
                                         a new recipient is held for the
                                         operator). Inbound mail lands in
                                         inbox/ at wake start and on every
                                         operon pull${mark(caps.email)}
  operon email original <id>             the stored, UNREDACTED original of an
                                         inbound message (id = the 8-char
                                         prefix in the inbox file's name), for
                                         withheld lines like verification
                                         links. Never save the credential
                                         parts to your repo.${mark(caps.email)}
  operon channel original <id>           the unredacted original of one
                                         operator-channel entry (id = the
                                         [#id] in operator/channel.md)${mark(caps.notify)}

PUBLISHING AND MONEY
  operon publish [dir] --host <host>     publish static files to an assigned
                                         host ("@" is the zone apex); dir
                                         defaults to "site"; swept for secrets
                                         first${mark(caps.publish)}
  operon till offer <host> <path> --price <p> --currency <c> --description <d>
                                         price a path of one of YOUR hosts;
                                         re-offer to update${mark(caps.till)}
  operon till retire <host> <path>       make a path free again${mark(caps.till)}
  operon till sales                      your offers and ledgered receipts${mark(caps.till)}
  operon pay <url> --max <amount> --reason <r>
                                         fetch a paid resource; payment runs
                                         through the spend Gatekeeper (you
                                         never hold a key); a FIRST payment to
                                         a new merchant is held for the
                                         operator, and so is an ABOVE-CAP
                                         payment (operator approval mints a
                                         one-time allowance; settle it by
                                         re-running the SAME pay)${mark(caps.pay)}
  operon pay proposals                   your pending holds and unspent
                                         allowances, across wakes: check here
                                         BEFORE re-asking the operator${mark(caps.pay)}

SECRETS THAT SURVIVE WAKES (never the repo; hard rule 7)
  operon vault set <label> --value <v>   store/update (or pipe value on stdin)${mark(caps.vault)}
  operon vault get <label>               retrieve a value to USE it${mark(caps.vault)}
  operon vault list                      labels and timestamps, no values${mark(caps.vault)}
  operon vault delete <label>            remove permanently${mark(caps.vault)}

X (your own labeled account; capped, ledgered, value first)
  operon x post --text <t>               post (or pipe text on stdin)${mark(caps.x)}
  operon x posts                         your recent posts (cross-wake memory)${mark(caps.x)}
  operon x me                            your profile as X sees it${mark(caps.x)}
  operon x dm <@handle> --text <t>       reply-only DM (someone must have
                                         DM'd you first); inbound DMs land in
                                         inbox/ at wake start and on pull${mark(caps.x)}

BROWSER (state persists across wakes)
  operon web open [name]                 CDP endpoint for a named session; the
                                         browser MCP is already on "default"${mark(caps.web)}
  operon web sessions                    where each session is logged in
                                         (domains, never values)${mark(caps.web)}
  operon web close <name>                end the live session, keep the state${mark(caps.web)}
  operon web password <name> --domains <a.com,b.com>
                                         mint a password DOOR-SIDE; you type a
                                         placeholder, never the value${mark(caps.web)}

GITHUB (a Gatekeeper holds the credential; you submit data)
  operon github status                   your PRs/issues + recent activity by
                                         others in allowlisted repos${mark(caps.github)}
  operon github thread <owner/repo> <n>  one PR/issue's full conversation${mark(caps.github)}
  operon github comment <owner/repo> <n> --body <text> | --body-file <f> [--reply-to <id>]${mark(caps.github)}
  operon github pr <owner/repo> [dir] --title <t> --body <b> [--submodule <path>=<sha>]
                                         propose a change to an allowlisted
                                         repo (dir defaults to "pr");
                                         --submodule advances a pointer to a
                                         40-hex sha (bump-only PRs need no dir)${mark(caps.pr)}
  operon github push <owner/repo> <n> [dir] --message <m>
                                         follow-up commits to YOUR open PR${mark(caps.github)}
  operon github update <owner/repo> <n> [--title <t>] [--body-file <f>] [--state open|closed]${mark(caps.github)}

Doors answer with named errors; the error names what to fix. A door
that is not wired answers *_not_wired. This guide is rendered live by
the chassis: what it says is what is true THIS wake.`;
}
