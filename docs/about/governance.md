# Governance

The governance structure is documented in
[`GOVERNANCE.md`](https://github.com/genspark-ai/genoffice/blob/main/GOVERNANCE.md).
This page is a snapshot for documentation readers.

## Steering Committee

3-5 maintainers from the GenOffice team. Decides:

- Release cadence.
- RFC approvals.
- Security policy.

## Working Groups

| WG | Scope | Maintainers |
|---|---|---|
| `@genoffice/editors` | docs · sheets · slides · pdf · markdown · html | docs + sheets leads |
| `@genoffice/ai` | Provider plugins + Skills + KB / TM + Agent Loop | AI lead |
| `@genoffice/sdk` | Web SDK + REST API + iframe Embed + IPC docs | SDK lead |
| `@genoffice/skills` | Skill marketplace + authoring guide | Marketplace lead |
| `@genoffice/infra` | Build / test / release / Docker / npm publish | Infra lead |

## RFC flow

1. Open a PR adding `docs/rfcs/0001-<slug>.md` with the **Proposed**
   status.
2. Discuss for at least 14 days in the PR.
3. WG vote → maintainer approval → status moves to **Accepted**.
4. Implementation lands in a follow-up PR.
5. RFC moves to `docs/rfcs/accepted/`.

## Voting

- WG members have one vote each.
- Maintainers can break ties.
- 50% + 1 quorum is required for non-trivial changes.

## How to join a WG

- Ship at least 3 PRs in the WG's scope over 6 months.
- Existing WG members nominate; maintainers confirm.
- Inactive members (no commits in 12 months) are gently rotated out.
