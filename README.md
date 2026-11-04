# GitLab workbench for DSH

## Version 2: task-driven workflow

The native landing page is now My work, with attention/progress/review/accepted filters. A three-step start wizard supports genuine Meegle-linked tasks and source-neutral technical work. Investigation mode forbids file changes and can finish with a human-accepted report without commits or an MR. The task workspace combines overview, actual bounded local diff, reported evidence, separately confirmed code publication and fresh GitLab review sections. See [the workflow guide](WORKFLOW.md) for the approved interaction and actual limits.

GitLab 2.0.0 pairs with Meegle 5.0.0. The same Meegle execution registry owns both sources. Optional Client navigation services retain exact task/work-item context; no duplicate task store is introduced. Task scope instructions are not a replacement for DSH tool policy. Ordinary drafts survive in-page panel navigation only, not a full reload; PATs never enter that draft store.

Review requests span repositories for the current reviewer. MR, pipeline, discussion and approval readbacks are separately marked unavailable/unknown rather than inferred passing. CI success must match the current MR SHA. Release integration is not connected; external GitLab handles approval, conflict resolution and merge. Automatic clone, release, independent test execution and cleanup are not implemented.

Known published branches can continue through the original exact Draft MR after a new report: pinned prior delivery/head/MR and original title/body/marker are retained. Both local ancestry and exact remote head are checked, pushes are non-force, and the MR step is GET-only verification rather than another POST/PUT. Ordinary Git push is not an atomic remote compare lock: an out-of-band race can still occur, so pre/post checks and manual review remain necessary.

New continuation fields and technical/analysis task records are optional extensions of the existing domains. Do not downgrade to an older strict reader after writing these records without a complete domain/credential/config backup and manual reconciliation. Activation uses the supported plugin manager lifecycle, not direct profile file edits.

Native GitLab browsing and a Host workspace provider for Meegle execution tasks. The panel browses projects, branches and open MRs; binds existing local checkouts; shows retained environments and delivery records. Credential management and checkout binding are user-only. Push and Draft MR publication are separately confirmed in the consuming task workflow, not automatic effects of an agent report.

## Authentication and storage

Use your GitLab instance HTTPS base URL (including a relative deployment prefix or custom HTTPS port if applicable) and a Personal Access Token. Read-only browsing needs the appropriate GitLab read permissions; Draft MR creation needs API write permission. GitLab permissions and protected branches still apply. The plugin checks `/api/v4/user`, freezes its numeric user id for the connection, and rejects replacing a connection with a different instance or user.

PATs are stored only in DSH credential records (`api-key`, under a plugin-specific key), never in plugin configuration, domain records, Git remotes, command arguments, UI responses, model prompts or logs. Requests do not follow redirects; the configured HTTPS origin is the explicit credential destination. A deployment administrator controls TLS trust. The plugin does not impose a public-host allowlist because self-hosted/private GitLab is a supported use case; do not connect untrusted URLs. Response bodies, request bodies, API page sizes, Git output and execution time are bounded. API/Git errors use fixed public messages and omit server response bodies/stderr.

Connections, checkout bindings, environments and delivery intents use a versioned `storageDomain`, validated with Zod 4.1.12. Failure to open durable storage fails closed; there is no volatile fallback. Credential revocation disconnects this plugin only, not Git's separate SSH agent or credential helper. No OAuth, automatic clone, fetch, cleanup or CI integration is included.

## Native environment lifecycle

1. Bind an existing absolute Git repository root. Git remote fetch and push URLs must each be a single HTTPS or SSH target matching the chosen GitLab instance/project. HTTPS compares the exact port and instance prefix; SSH compares the host and project path (the SSH port is independent of HTTPS).
2. Review a plan pinned to an existing local remote-tracking target ref, or a local target branch if no remote-tracking ref is available. No network Git read is performed. A stale local ref is still stale: fetch manually with your existing Git authentication before planning.
3. The consuming Host workflow creates/resolves the exact DSH session. `prepare` checks a fresh plan, durably records preparation intent, changes that session to the bound source, invokes native `worktrees.create` at the pinned SHA, then uses `workingDirectory.set` for the exact canonical subdirectory. It never sends model prompts. A preparation id is idempotent; ambiguous preparation retains its artifact information and cannot be silently repeated.
4. Worktrees are retained and never automatically deleted. Source uncommitted files are not copied. The configured subdirectory must exist in the pinned checkout; otherwise creation may leave an unknown retained environment for manual inspection.

**A worktree is not a security sandbox.** Native DSH worktree creation enforces the session's filesystem/sandbox policy; no permission elevation is requested and directory changes do not change session permissions. Processes, credentials, ports, databases, external tools and repository configuration remain shared/trusted. Do not run untrusted repositories with elevated policy. Local metadata checks run bounded `execFile('/usr/bin/git', ..., {shell:false})`, with hooks/fsmonitor/file/ext transports disabled and ambient Git repository/config overrides removed. Confirmed push intentionally uses existing Git SSH/credential-helper authentication; its trusted Git/SSH/helper configuration may execute code. PATs are not passed to Git. There is no claim to isolate arbitrary Git repository configuration or defeat concurrent out-of-band local modifications.

## Delivery safety

A delivery preview freezes task, environment, report revision, source branch, HEAD SHA, remote/project, target branch, Draft title, description and unique marker. Worktree must be clean. Local branch/canonical directory/session binding and HEAD are revalidated before each write. User confirmation refers to that frozen preview; a changed HEAD or remote invalidates it.

A confirmed push sends only the pinned SHA to the intended source branch, never force-pushes and skips hooks. A first delivery refuses a different pre-existing remote branch; a proven continuation additionally allows only the exact previously verified remote head with local fast-forward ancestry. Push authentication uses existing Git setup, not the API PAT. A successful API branch readback establishes `pushed`, not `verified`.

A separately confirmed publication first checks the remote branch and existing open MRs, durably stores publication intent, and creates one Draft MR. A fresh GET of the MR plus branch/local environment checks must match the complete frozen preview before `verified`. GitLab has no cross-request transaction; a concurrent external mutation can still race checks. Always review the MR in GitLab before merging.

Interrupted/timed-out writes become `unknown` or retain the in-flight intent across restart. They are never blindly repeated. `verifyDelivery` performs readbacks and validates the current local environment/HEAD. A matching remote branch alone can recover `pushed`; only an exact open Draft MR with marker/target/title/description/SHA and matching local HEAD yields `verified`. Absence is not proof that a remote write failed, so unknown publication does not unlock another POST. Manual remediation of genuinely failed uncertain writes is deliberately outside this version.

## Integration and verification

See API.md for the raw `gitlabWorkspace` service contract and the authenticated POST API. Native worktree/session services are optional for ordinary browsing; unavailable preparation fails explicitly. Domain/credentials/connection/tools are required.

Run `node --test tests/*.test.js` after dependencies are available. Host tests use fake GitLab responses and temporary repositories only; no real network write is performed. They cover route admission, agent/user authority, PAT handling, URL/remote validation, local plans, native preparation, pinned delivery, restart uncertainty and stale HEAD rejection. Installation, live credential storage/backend behavior, native sandbox integration and rendered UI require verification in the parent session; unit tests do not establish those runtime facts.

The SVG branch icon is original artwork created for this bundle. English and Chinese plugin metadata are included.
