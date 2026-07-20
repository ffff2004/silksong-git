# Issue tracker: GitHub

Issues and PRDs for this repo live as GitHub issues in `ffff2004/silksong-git`. Use the `gh` CLI for all operations.

## Conventions

- **Create an issue**: `gh issue create -R ffff2004/silksong-git --title "..." --body "..."`. Use a heredoc for multi-line bodies.
- **Read an issue**: `gh issue view <number> -R ffff2004/silksong-git --comments`, filtering comments by `jq` and also fetching labels.
- **List issues**: `gh issue list -R ffff2004/silksong-git --state open --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'` with appropriate `--label` and `--state` filters.
- **Comment on an issue**: `gh issue comment <number> -R ffff2004/silksong-git --body "..."`.
- **Apply or remove labels**: `gh issue edit <number> -R ffff2004/silksong-git --add-label "..."` or `--remove-label "..."`.
- **Close**: `gh issue close <number> -R ffff2004/silksong-git --comment "..."`.

This clone has both `origin` and `upstream`. When a command accepts a repository,
always pass `-R ffff2004/silksong-git`; do not rely on remote inference. For
`gh api`, which does not accept `-R`, use a complete
`repos/ffff2004/silksong-git/...` endpoint.

## Pull requests as a triage surface

**PRs as a request surface: no.** _(Set to `yes` if this repo treats external PRs as feature requests; `/triage` reads this flag.)_

When set to `yes`, PRs run through the same labels and states as issues, using the `gh pr` equivalents:

- **Read a PR**: `gh pr view <number> -R ffff2004/silksong-git --comments` and `gh pr diff <number> -R ffff2004/silksong-git` for the diff.
- **List external PRs for triage**: `gh pr list -R ffff2004/silksong-git --state open --json number,title,body,labels,author,authorAssociation,comments`, then keep only `authorAssociation` of `CONTRIBUTOR`, `FIRST_TIME_CONTRIBUTOR`, or `NONE` and drop `OWNER`, `MEMBER`, and `COLLABORATOR`.
- **Comment, label, or close**: use `gh pr comment`, `gh pr edit`, or `gh pr close` with `-R ffff2004/silksong-git`.

GitHub shares one number space across issues and PRs, so a bare `#42` may be either. Resolve it with `gh pr view 42 -R ffff2004/silksong-git` and fall back to `gh issue view 42 -R ffff2004/silksong-git`.

## When a skill says "publish to the issue tracker"

Create a GitHub issue in `ffff2004/silksong-git`.

## When a skill says "fetch the relevant ticket"

Run `gh issue view <number> -R ffff2004/silksong-git --comments`.

## Wayfinding operations

Used by `/wayfinder`. The **map** is a single issue with **child** issues as tickets.

- **Map**: a single issue labelled `wayfinder:map`, holding the Notes, Decisions-so-far, and Fog body. Create it with `gh issue create -R ffff2004/silksong-git --label wayfinder:map`.
- **Child ticket**: an issue linked to the map as a GitHub sub-issue using `gh api` on the sub-issues endpoint. Where sub-issues are unavailable, add the child to a task list in the map body and put `Part of #<map>` at the top of the child body. Label it `wayfinder:<type>`: `research`, `prototype`, `grilling`, or `task`. Once claimed, assign the ticket to the driving developer.
- **Blocking**: use GitHub's native issue dependencies as the canonical, UI-visible representation. Add an edge with `gh api --method POST repos/ffff2004/silksong-git/issues/<child>/dependencies/blocked_by -F issue_id=<blocker-db-id>`, where `<blocker-db-id>` is the blocker's numeric database ID from `gh api repos/ffff2004/silksong-git/issues/<number> --jq .id`, not the issue number or `node_id`. GitHub reports open blockers in `issue_dependencies_summary.blocked_by`. Where dependencies are unavailable, fall back to a `Blocked by: #<number>, #<number>` line at the top of the child body. A ticket is unblocked when every blocker is closed.
- **Frontier query**: list the map's open children, drop any with an open blocker or an assignee, and take the first in map order. Scope children through GitHub sub-issues when available or the map task list fallback otherwise.
- **Claim**: `gh issue edit <number> -R ffff2004/silksong-git --add-assignee @me`. This is the session's first write.
- **Resolve**: comment on the ticket with the answer, close it, then append a context pointer consisting of a gist and link to the map's Decisions-so-far.
