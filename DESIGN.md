# Task-driven native GitLab workspace

## Approved direction
The user approved the task-driven redesign in this session. Preserve DSH native slots, locale, theme and permissions; replace the resource-led navigation and fragmented handoffs. No standalone app, iframe, replacement server or invented CI/release state.

## Direction contract
THESIS: One work item remains the context from starting work through code review. The first screen answers what needs attention and how to continue, not how many technical resources exist.
OWN-WORLD: DSH system typography and inspected --dsw-alias-* tokens, dense readable rows, clear dividers and visible keyboard focus. State colors signify actual observations, never Agent claims.
STORY: Work queue → source/goal/location wizard → exact reviewed start → bound session → report and local diff → separately authorized push and Draft MR → remote review facts. Technical work can begin without a Meego business item; business identity stays authoritative where linked.
FIRST VIEWPORT: Native page heading and start-work action, three primary navigation destinations (My work, Repositories, Settings), actionable work filters and compact matter rows. Detail replaces the queue, with a back path, next action and contextual tabs. Narrow panels stack instead of nesting sidebars.
FORM: User-pinned task-first operate surface; seed: none (user-pinned). Progressive disclosure puts paths, hashes and raw metadata behind details, while approval summaries retain exact resources and consequences.
FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance.

## Interaction contract
- Effect-owned optional Client navigation services link exact tasks, repositories and Meego work items; no DOM injection or cross-window events.
- Every request is keyed by endpoint and exact identity, abortable on navigation, and retains stale data only for the same identity.
- Start wizard saves an execution task and prepares a plan; worktree/session allocation and prompting require a distinct confirmation of that plan.
- Submission is a continuous page with separate frozen push and MR authorization, never one blanket publish permission.
- Session dispatch is not proof of ongoing model activity; Agent test claims are labeled reported, not independently verified.
- Review shows actual GitLab MR/pipeline/discussion facts and timestamps, including unavailable/unknown. No CI or release provider means not connected, not passed.
- Existing local-directory Meego workflows and durable state remain supported. Technical work reuses execution ownership rather than introducing a duplicate GitLab task registry.
- Failed/uncertain writes retain identity and cannot be blindly replayed. MR iteration stays on the original branch/MR with pinned fast-forward checks, never force push.
- No automatic clone, rebase, merge, deploy or environment deletion. Unsupported operations use honest guidance and external links rather than dead buttons.

## Verification
Static, behavioral and temporary-repository tests are necessary but do not establish rendered correctness. Verify the installed native page on the existing DSH URL when browser control is available. Record exact runtime loading and remaining checks without equating slot registration with a visual pass.
