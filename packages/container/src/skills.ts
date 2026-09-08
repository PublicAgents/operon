import { describeBudget, type McpBudgetView } from "./mcp-budget.js";
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

/**
 * A door the operator CLOSED (spec 0006 §7) says so, rather than "not
 * wired": the second sends the mind looking for a missing secret, the
 * first tells it the decision was made and where to ask.
 */
function doorMarker(disabled: Set<string>): (door: string, live: unknown) => string {
  return (door, live) => (disabled.has(door) ? "   [DISABLED by the operator]" : mark(live));
}

export interface AskLimits {
  perWake: number;
  perDay: number;
}

export function renderSkills(
  config: WakeConfig,
  caps: Record<string, unknown>,
  /**
   * This colony's real ask ceilings, as the asks Gatekeeper stated them
   * at wake start. Absent when that door is not wired or did not
   * answer, and then the guide says a ceiling exists without inventing
   * a number: a wrong number here is worse than no number, because the
   * mind would plan against it.
   */
  askLimits?: AskLimits
): string {
  void config; // reserved: future per-colony guidance (hosts, PR targets)
  const writeRepos = Array.isArray(caps.githubWrite) ? (caps.githubWrite as string[]) : [];
  const reviewRepos = Array.isArray(caps.githubReview) ? (caps.githubReview as string[]) : [];
  const registry =
    typeof caps.registry === "object" && caps.registry !== null
      ? (caps.registry as { site: string; repo: string })
      : undefined;
  const prRepoList = Array.isArray(caps.prRepos) ? (caps.prRepos as string[]) : [];
  const registrySection = registry
    ? `
REGISTRY (spec 0013: every agent of this colony keeps a public entry)
  You are listed, or should be, at ${registry.site}/@<your handle>.
  Read ${registry.site}/SKILL.md first; it says exactly what an entry
  is and how it is verified. To register or to update your entry:
    1. publish /.well-known/public-agents.json on your homepage naming
       your handle and your machine login (a static file; operon
       publish carries it with the rest of your site)
    2. operon github pr ${registry.repo} ... with your entry files${
      prRepoList.some(repo => repo.toLowerCase() === registry.repo.toLowerCase())
        ? ""
        : "\n       (you adjudicate on that repo, so you never author there:\n        a colleague files and maintains your entry)"
    }
  Keep the entry true when your surfaces, models or claims change. The
  reviewer there refuses by name; fix and resend. Never edit another
  party's entry: file evidence or an issue instead.
`
    : "";
  const mergeRepos = Array.isArray(caps.githubMerge) ? (caps.githubMerge as string[]) : [];
  const mcpServers = Array.isArray(caps.mcp) ? (caps.mcp as string[]) : [];
  const mcpBudgets = (Array.isArray(caps.mcpBudgets) ? (caps.mcpBudgets as McpBudgetView[]) : []).filter(
    view => view.budgeted || view.error
  );
  const door = doorMarker(new Set(Array.isArray(caps.disabledDoors) ? (caps.disabledDoors as string[]) : []));
  const localBrowserNote = caps.localBrowser === false ? " [switched off for this agent]" : "";
  const askCeiling = askLimits
    ? `at most ${askLimits.perWake} per wake, ${askLimits.perDay} per day`
    : "there is a per-wake ceiling; the door names it if you reach it";
  return `operon: the doors out of this wake (fresh guidance; re-run any time)

WHEN TO REACH FOR WHAT
  Something should have arrived (a reply, a verification link, a DM,
    an operator answer)? -> operon pull. Mail, X DMs, and operator
    messages are delivered at wake start AND ON DEMAND: pull fetches
    whatever arrived SINCE, mid-wake, into inbox/ and
    operator/channel.md. A verification email sent two minutes ago is
    one pull away, not one wake away. Safe to repeat; nothing is lost
    or double-acked.
  A delivered message has a line withheld (a sign-up or confirmation
    link)? -> operon email original <id> / operon channel original <id>
    reads that message as it arrived.
  Tell the operator something -> operon notify (they may answer
    MID-WAKE: pull before you sleep if you asked).
  BLOCKED on a human decision (permission, a judgment call, a thing only
    they can do)? -> operon ask. Unlike a notify, an ask is durable and
    threaded: it waits in the operator's queue with its own state, and
    their answer reaches you at wake start or on operon pull, however
    many wakes later. Post it wherever it also belongs (a GitHub issue,
    an email) AND file the ask, so the decision has one home.
  Read a page, check a site, take a screenshot, look something up:
    anything where you are nobody in particular -> the "playwright" MCP
    tools FIRST (Chrome in this container, on this wake's own network;
    it starts blank every wake and remembers nothing afterwards).${localBrowserNote}
  Sign in somewhere, or work in a site where you are already signed in
    -> ONLY the "browser" MCP tools of the web door (session "default",
    which the door keeps for you between wakes); operon web sessions
    lists the sites that session knows you at, and operon web password
    lets the door fill a sign-in form for you. The playwright browser
    forgets everything at wake end, so signing in there is wasted work.
  Ship pages -> operon publish. Sell a path -> operon till offer. Buy
    -> operon pay. Post -> operon x post. Something you must still have
    next wake, and must not commit -> operon vault.
  Not sure what is wired right now -> operon capabilities.

CHECKING FOR NEW INPUT (mid-wake)
  operon pull                            fetch new email, X DMs, and operator
                                         messages since wake start (or your
                                         last pull); answers with counts${mark(caps.email || caps.notify || caps.x)}

MESSAGING AND MAIL
  operon notify <text...>                message the operator${door("notify", caps.notify)}
  operon email --to <addr> --subject <s> --body <b>
                                         (long body? pipe it on stdin and omit
                                         --body; a literal --body - also reads
                                         stdin, never sends a dash)
                                         send an email (disclosed as an AI
                                         agent, rate-limited; a first email to
                                         a new recipient is held for the
                                         operator). Inbound mail lands in
                                         inbox/ at wake start and on every
                                         operon pull${door("email", caps.email)}
  operon email original <id>             one inbound message exactly as it
                                         arrived, including any line the
                                         delivery withheld (id = the 8-char
                                         prefix in the inbox file's name).
                                         Read what you need from it; do not
                                         copy those lines into your repo.${door("email", caps.email)}
  operon channel original <id>           one operator-channel entry exactly as
                                         it was written (id = the [#id] in
                                         operator/channel.md)${door("notify", caps.notify)}

PUBLISHING AND MONEY
  operon publish [dir] --host <host>     publish static files to an assigned
                                         host ("@" is the zone apex); dir
                                         defaults to "site"; swept for secrets
                                         first${door("publish", caps.publish)}
  operon till offer <host> <path> --price <p> --currency <c> --description <d>
                                         price a path of one of YOUR hosts;
                                         re-offer to update${door("till", caps.till)}
  operon till retire <host> <path>       make a path free again${door("till", caps.till)}
  operon till sales                      your offers and ledgered receipts${door("till", caps.till)}
  operon pay <url> --max <amount> --reason <r>
                                         fetch a paid resource; the spend
                                         Gatekeeper settles it on your behalf,
                                         so nothing payable passes through this
                                         container; a FIRST payment to
                                         a new merchant is held for the
                                         operator, and so is an ABOVE-CAP
                                         payment (operator approval mints a
                                         one-time allowance; settle it by
                                         re-running the SAME pay)${door("pay", caps.pay)}
  operon pay proposals                   your pending holds and unspent
                                         allowances, across wakes: check here
                                         BEFORE re-asking the operator${door("pay", caps.pay)}

${
  mcpServers.length > 0
    ? `MCP SERVERS (this wake's, already wired into your harness)
  ${mcpServers.join(", ")}
                                         Their tools appear as mcp__<server>__*
                                         in your tool list; they are wired for
                                         you and need nothing from you to
                                         connect. A tool the operator has not
                                         granted answers a named refusal rather
                                         than vanishing.${
                                           mcpBudgets.length > 0
                                             ? `
  Budgets (spec 0014): some servers are paid, and the whole colony
  shares one monthly cap per server, spread over the month's days.
  What is left today, as of wake start:
${mcpBudgets.map(view => `    ${describeBudget(view)}`).join("\n")}
  A call past today's share is refused by name (mcp_budget_exhausted)
  with what remains and when the day rolls; plan the wake against the
  number and do not retry a refused call. Re-read any time:
  operon mcp budget`
                                             : ""
                                         }

`
    : ""
}ASKS (a decision you need from your operator, durable across wakes)
  operon ask <decision|request|question> --title <t> --body <b> [--link <url>]
                                         file it in the operator's queue: a
                                         decision (allow or decline), a request
                                         (something only they can do), or a
                                         question. State what you will do with
                                         each answer, and what you are doing
                                         meanwhile. ${askCeiling}, so
                                         consolidate rather than file ten
                                         small ones${door("asks", caps.ask)}
  operon ask list                        your asks, their state, and operator
                                         replies you have not read yet${door("asks", caps.ask)}
  operon ask reply <id> --text <t>       add to the thread (or pipe on stdin)${door("asks", caps.ask)}
  operon ask retract <id> [--reason <r>] withdraw one you no longer need
                                         answered: do this rather than leave
                                         a stale ask sitting in their queue${door("asks", caps.ask)}
  operon ask close <id> [--note <n>]     you got what you needed${door("asks", caps.ask)}

WHAT MUST OUTLIVE A WAKE BUT NEVER ENTER THE REPO (hard rule 7)
  operon vault set <label> --value <v>   keep it under a label for later wakes${door("vault", caps.vault)}
                                         (or pipe the value in on stdin)
  operon vault get <label>               read one back when you need to use it${door("vault", caps.vault)}
  operon vault list                      your labels and when they changed${door("vault", caps.vault)}
  operon vault delete <label>            drop one for good${door("vault", caps.vault)}

X (your own labeled account; capped, ledgered, value first)
  operon x post --text <t>               post (or pipe text on stdin)${door("x", caps.x)}
  operon x posts                         your recent posts (cross-wake memory)${door("x", caps.x)}
  operon x me                            your profile as X sees it${door("x", caps.x)}
  operon x dm <@handle> --text <t>       reply-only DM (someone must have
                                         DM'd you first); inbound DMs land in
                                         inbox/ at wake start and on pull${door("x", caps.x)}

WEB DOOR (the browser whose session the door keeps between wakes)
  operon web open [name]                 CDP endpoint for a named session; the
                                         browser MCP is already on "default"${door("web", caps.web)}
  operon web sessions                    which sites each session knows you at
                                         (domains only)${door("web", caps.web)}
  operon web close <name>                end the live session, keep the state${door("web", caps.web)}
  operon web password <name> --domains <a.com,b.com>
                                         let the door fill a sign-in form for
                                         those domains; you type a placeholder
                                         and the door completes it${door("web", caps.web)}

GITHUB (a Gatekeeper acts as your account; you submit the content)
  operon github status                   your PRs/issues + recent activity by
                                         others in allowlisted repos${door("github", caps.github)}
  operon github thread <owner/repo> <n>  one PR/issue's full conversation${door("github", caps.github)}
  operon github comment <owner/repo> <n> --body <text> | --body-file <f> [--reply-to <id>]${door("github", caps.github)}
  operon github pr <owner/repo> [dir] --title <t> --body <b> [--submodule <path>=<sha>]
                                         propose a change to an allowlisted
                                         repo (dir defaults to "pr");
                                         --submodule advances a pointer to a
                                         40-hex sha (bump-only PRs need no dir)${door("github", caps.pr)}
  operon github push <owner/repo> <n> [dir] --message <m>
                                         follow-up commits to YOUR open PR${door("github", caps.github)}
  operon github update <owner/repo> <n> [--title <t>] [--body-file <f>] [--state open|closed]${door("github", caps.github)}
  operon github branch <owner/repo> [dir] --branch <b> --message <m>
                                         commit straight to a NON-DEFAULT branch
                                         of a repo you hold a WRITE grant on${
                                           writeRepos.length > 0 ? ` (${writeRepos.join(", ")})` : ""
                                         }; the default branch is refused,
                                         because review happens on a PR${mark(writeRepos.length > 0)}
  operon github review <owner/repo> <n> --approve | --request-changes | --comment [--body <t> | --body-file <f>]
                                         post a review on a PR of a repo you hold
                                         a REVIEW grant on${reviewRepos.length > 0 ? ` (${reviewRepos.join(", ")})` : ""}.
                                         NEVER your own PR. The review binds to
                                         the head you read. A body is required
                                         unless you approve${mark(reviewRepos.length > 0)}
  operon github merge <owner/repo> <n>   merge a PR of a repo you hold a MERGE
                                         grant on${mergeRepos.length > 0 ? ` (${mergeRepos.join(", ")})` : ""}, only if it
                                         qualifies: open, green on the named
                                         checks, approved by ANOTHER agent on the
                                         current head, inside the data paths.
                                         Anything else is HELD for the operator:
                                         held means wait, do not retry the same
                                         head. Never your own authorship${mark(mergeRepos.length > 0)}
  operon github close <owner/repo> <n> --reason <text>
                                         close another party's PR (spam, or one
                                         that will never qualify), reason on the
                                         record; merge-granted repos only${mark(mergeRepos.length > 0)}

${registrySection}
Doors answer with named errors; the error names what to fix. A door
that is not wired answers *_not_wired. This guide is rendered live by
the chassis: what it says is what is true THIS wake.`;
}
