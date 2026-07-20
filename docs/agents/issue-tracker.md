# Issue tracker: GitHub

Issues and PRDs for this repo live as GitHub issues in `ffff2004/silksong-git`. Use the `gh` CLI for all operations.

## Conventions

- **Create an issue**: `gh issue create --title "..." --body "..."`. Use a heredoc for multi-line bodies.
- **Read an issue**: `gh issue view <number> --comments`, filtering comments by `jq` and also fetching labels.
- **List issues**: `gh issue list --state open --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'` with appropriate `--label` and `--state` filters.
- **Comment on an issue**: `gh issue comment <number> --body "..."`.
- **Apply or remove labels**: `gh issue edit <number> --add-label "..."` or `--remove-label "..."`.
- **Close**: `gh issue close <number> --comment "..."`.

## Global frontier

The global frontier is every open `ready-for-agent` issue that has no assignee
and no reported blocker. It covers standalone issues and child tickets without
requiring a repository-maintained initiative list:

```sh
gh issue list --state open --limit 1000 \
  --search 'label:ready-for-agent no:assignee -is:blocked' \
  --json number,title,labels,assignees
```

Treat this query as candidate discovery. Before claiming an issue, fetch its
native dependency data and confirm every blocker is closed.

## Generic ticket operations

Fetch the complete human-facing ticket context:

```sh
gh issue view <number> --comments \
  --json number,title,state,body,comments,labels,assignees
```

Fetch its parent, child summary, and dependency summary:

```sh
gh api repos/ffff2004/silksong-git/issues/<number> \
  --jq '{parent, sub_issues_summary, issue_dependencies_summary}'
```

List the ticket's blockers and children:

```sh
gh api repos/ffff2004/silksong-git/issues/<number>/dependencies/blocked_by \
  --jq '[.[] | {number, title, state}]'
gh api repos/ffff2004/silksong-git/issues/<number>/sub_issues --paginate \
  --jq '.[] | {number, title, state}'
```

GitHub relationship writes use numeric database IDs, not issue numbers or
`node_id` values. Read one with
`gh api repos/ffff2004/silksong-git/issues/<number> --jq .id`, then:

- add a child with
  `gh api --method POST repos/ffff2004/silksong-git/issues/<parent>/sub_issues -F sub_issue_id=<child-db-id>`;
- add a blocker with
  `gh api --method POST repos/ffff2004/silksong-git/issues/<ticket>/dependencies/blocked_by -F issue_id=<blocker-db-id>`; and
- claim with
  `gh issue edit <number> --add-assignee @me`.

Create related issues before wiring relationships so every edge can use a real
tracker identity.

## Implementation lifecycle

Before implementation:

1. Fetch the ticket, comments, labels, assignee, parent, children, and blockers.
2. Confirm it is open, `ready-for-agent`, unassigned, and has no open blocker.
3. Read its Parent Spec and the relevant domain, Architecture, Reference, and ADR
   authorities.
4. Claim it. This is the session's first tracker write.
5. Implement only its accepted scope and keep its acceptance criteria visible.

If scope, acceptance, dependencies, or execution state changes, update GitHub
when that change occurs. Record durable implemented behavior in the owning
repository authority; do not maintain implementation logs in prose docs.

On completion:

1. Check every satisfied acceptance criterion in the issue body.
2. Comment with the commit SHA, exact verification commands and results,
   authoritative documents changed, and links to non-blocking follow-ups.
3. Remove the active workflow label such as `ready-for-agent`, then close the
   issue. Keep its category label. A rejected issue instead retains `wontfix`.
4. Close a Parent Spec only after all child tickets and final integration
   verification are complete; add a parent-level completion summary first.

## Pull requests as a triage surface

**PRs as a request surface: no.** _(Set to `yes` if this repo treats external PRs as feature requests; `/triage` reads this flag.)_

When set to `yes`, PRs run through the same labels and states as issues, using the `gh pr` equivalents:

- **Read a PR**: `gh pr view <number> --comments` and `gh pr diff <number>` for the diff.
- **List external PRs for triage**: `gh pr list --state open --json number,title,body,labels,author,authorAssociation,comments`, then keep only `authorAssociation` of `CONTRIBUTOR`, `FIRST_TIME_CONTRIBUTOR`, or `NONE` and drop `OWNER`, `MEMBER`, and `COLLABORATOR`.
- **Comment, label, or close**: use `gh pr comment`, `gh pr edit`, or `gh pr close`.

GitHub shares one number space across issues and PRs, so a bare `#42` may be either. Resolve it with `gh pr view 42` and fall back to `gh issue view 42`.

## When a skill says "publish to the issue tracker"

Create a GitHub issue in `ffff2004/silksong-git`.

## When a skill says "fetch the relevant ticket"

Use the commands in [Generic ticket operations](#generic-ticket-operations),
including native relationship and dependency reads.

## Project-level rejected enhancements

Use `.out-of-scope/<concept>.md` as the durable owner for an enhancement the
project has explicitly decided not to support. Create the directory lazily when
the first rejection is accepted, keep one concept per file, and record the
rejected outcome, the reason, and links to relevant requests or decisions.

Do not use this directory for deferred work, rejected implementation approaches,
bugs, or behavior the project already supports. A spec's `Out of Scope` section
applies only to that effort, and a Wayfinder map's `Out of Scope` section applies
only to that destination. If the project reconsiders a rejected enhancement,
remove its file before returning the outcome to tracker planning or triage.

## Wayfinding operations

Used by `/wayfinder`. The **map** is a single issue with **child** issues as tickets.

- **Map**: a single issue labelled `wayfinder:map`, holding the Notes, Decisions-so-far, and Fog body. Create it with `gh issue create --label wayfinder:map`.
- **Child ticket**: create an issue labelled `wayfinder:<type>` (`research`, `prototype`, `grilling`, or `task`), then link it to the map using the generic native sub-issue operation. Where sub-issues are unavailable, add it to a task list in the map body and put `Part of #<map>` at the top of the child body.
- **Blocking**: use the generic native dependency operation. Where dependencies are unavailable, fall back to a `Blocked by: #<number>, #<number>` line at the top of the child body. A ticket is unblocked when every blocker is closed.
- **Frontier query**: list the map's open children, drop any with an open blocker or an assignee, and take the first in map order. Scope children through GitHub sub-issues when available or the map task list fallback otherwise.
- **Claim**: use the generic claim operation before doing any ticket work.
- **Resolve**: comment on the ticket with the answer, close it, then append a context pointer consisting of a gist and link to the map's Decisions-so-far.
