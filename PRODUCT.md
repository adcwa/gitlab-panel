# GitLab development workspace

## Approved purpose
A native task-driven DSH workspace for an IT developer's daily work: pick up a Meegle work item or technical investigation, choose the repository, confirm an execution plan, continue the exact Session, inspect reported evidence and actual diff, publish reviewed code, and follow the same MR through revision.

## Primary navigation
My work (attention, in progress, review requests, accepted results, all work) → Repositories → Settings. Retained worktrees and repository MRs remain reachable from repository detail, not as the default landing page.

## Work-item ownership
The existing Meegle execution registry remains the single execution owner. Source-linked work retains authoritative business identity. Technical work uses strict source:{kind:'technical'} and contains no fake Meegle connection/work-item identity. Client navigation carries exact context between independent native plugins.

## Work types
- Code change: creates retained worktree after confirmation; report, local diff inspection, separately confirmed pinned push and Draft MR, fresh provider verification before result acceptance.
- Investigation/analysis: explicit no-file-change scope, optional authorized commands, report and human acceptance after fresh environment checks. No commit/MR/release is required or permitted through delivery actions.

## Shipping in GitLab v2 / Meegle v5
- Work queue, source-preserving startup wizard, exact plan approval and task workspace.
- Contextual navigation and explicit local-directory fallback.
- Goal drafts retained in plugin memory across panel navigation, with explicit replacement and reload warning. Credentials never enter draft storage.
- Actual bounded diff/dirty-file inspection for the bound environment; Agent tests labeled as reported, not independently verified.
- Per-user cross-project review requests and read-only MR/pipeline/discussion/approval sections, including unavailable/unknown and observation time.
- Same-MR non-force fast-forward iteration; original MR publication content and marker frozen; no duplicate MR or hidden MR edit.
- Separate execution, code and release meanings. GitLab result acceptance no longer requires publishing a Meegle comment. Meegle comments remain explicit business actions.

## Boundaries and deferred capabilities
No automatic clone/fetch, independent test runner, automatic discussion reply/approval/resolution, rebase, force push, merge, deployment, release-provider integration or automatic cleanup. CI is read from GitLab for the exact MR head. Empty pipeline pages do not establish absent CI. Business-node completion for GitLab work remains disabled until a delivery policy is configured. Ordinary directory Meegle node flows are unchanged.

A worktree or selected subdirectory is not a security sandbox. Task scope instructions do not replace DSH permissions. API PAT authentication is distinct from Git SSH/credential-helper authentication. External repositories, Git configuration and commands remain trusted according to the existing Session policy.

## Verification contract
No production write is part of implementation testing. Use synthetic responses and temporary repositories for creation, revision, unknown-outcome recovery, source identity and privilege boundaries. Native package activation and real read-only APIs verify loading; they do not prove visual/accessibility correctness. Rendered verification requires an authenticated browser session and must be reported separately.
