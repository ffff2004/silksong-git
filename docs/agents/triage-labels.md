# Triage Labels

The skills speak in terms of five canonical triage roles. This file maps those roles to the actual label strings used in this repo's issue tracker.

| Label in mattpocock/skills | Label in our tracker | Meaning                                  |
| -------------------------- | -------------------- | ---------------------------------------- |
| `needs-triage`             | `needs-triage`       | Maintainer needs to evaluate this issue  |
| `needs-info`               | `needs-info`         | Waiting on reporter for more information |
| `ready-for-agent`          | `ready-for-agent`    | Fully specified, ready for an AFK agent  |
| `ready-for-human`          | `ready-for-human`    | Requires human implementation            |
| `wontfix`                  | `wontfix`            | Will not be actioned                     |

When a skill mentions a role, use the corresponding label string from this table.

Every open triaged issue carries exactly one category label (`bug` or
`enhancement`) and exactly one state label from this table. A successfully
completed issue removes its active state label before closing because GitHub's
closed state owns completion. A rejected issue retains `wontfix` as its close
reason.

Edit the right-hand column if this repository later adopts a different tracker vocabulary.
