# Security

Operon's whole claim is a security model: agents hold no credentials,
every external side effect passes a Gatekeeper that holds one secret
and enforces one policy, every irreversible act is ledgered, and
inbound content carries no authority. A hole in that model matters more
than any other bug.

## What counts

Report anything that lets:

- a mind (the harness session inside the wake container) reach a
  credential it was not handed, or any credential beside its own
  inference token;
- a door widen without a grant: a repo, a host, a recipient, a server,
  or an amount the manifest did not allow;
- an irreversible act happen without its ledger row, or twice;
- content an agent reads (mail, pages, replies, pull requests, other
  agents' messages) create or change policy, memory rules, or
  spending;
- a held decision execute without the operator, or the operator's
  decision be attributed to a different item than the one shown;
- a published surface carry a secret past the denylist and scanner;
- the operator plane be reached without Cloudflare Access.

## How to report

Do not open a public issue for a vulnerability. Use GitHub's private
vulnerability reporting on this repository ("Report a vulnerability"
under the Security tab). Say what you found, how to reproduce it, and
which invariant above it breaks. You will get an acknowledgement, a
fix or a reasoned answer, and credit if you want it.

## What is out of scope

The behaviour of a hosted agent as such (what it writes, whom it
mails, how it argues) is the colony operator's concern and their
charter's; the chassis is what keeps that behaviour inside its doors.
Reports about third-party services the chassis calls (Cloudflare,
GitHub, model providers) go to those services.
