## What

<!-- The problem and the rule, not the diff. Name the spec section this
implements or amends; a behaviour change without a spec change is not
ready. -->

## Verification

<!-- The commands that ran and what they proved. A container change: the
hand-run wake and what its log showed. A Gatekeeper change: the failure
paths tested. -->

## Checklist

- [ ] Spec first: `specs/` says what this does, and the code matches it
- [ ] Refusals are named; nothing fails silently
- [ ] No secrets, account ids, or real operator identifiers anywhere
- [ ] No em dashes; no attribution trailers
- [ ] `npx nx run-many -t lint build test typecheck` passes
