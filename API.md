# GitLab Host API v2

## Task-driven additions

`status.capabilities` adds `workflowVersion:2`, `environmentInspection:true`, `reviewFacts:true`, `sameMrContinuation:true`, and `worktreeAvailability:'resolved-at-session-start'`. The legacy nativeWorktrees flag reports root-scope availability only; preparation also resolves the exact session preset's native services.

Browser-user-only actions (not admitted by the general Agent tool):

- `inspectEnvironment {environmentId}` → `{environmentId,headSha,branch,clean,files:[{path,status}],filesTruncated,diff,diffTruncated,dirty:{status,truncated},observedAt}`. Fixed bounded local Git commands; exact session/environment verified before and after inspection. No arbitrary repository paths.
- `review {connectionId,projectId,mrIid}` → `{connectionId,projectId,mrIid,mr,pipeline,discussions,notes,approvals,observedAt}`. Each section is `{status:'available',data}` or `{status:'unavailable',reason}`. MR state includes opened/closed/merged. Pipeline state is actual status for the exact current MR SHA, `unknown`, or `not_configured` only when explicitly disabled. Notes/discussions are bounded and expose hasMore/truncation. Approval values can be null, never inferred passing.
- `reviewRequests {connectionId,page?}` → `{items:[MR + projectId],page,hasMore}` under the standard data envelope; current authenticated identity's reviewer_id across repositories.

The raw provider façade additionally exposes inspectEnvironment, readReview/review and reviewRequests to trusted Host consumers. They are not authorization by themselves.

Continuation previews optionally carry all of `priorDeliveryId`, `priorHeadSha`, `priorMR`, plus the original marker, frozen title/body and raceLimits. Incomplete proof is rejected. The provider selects continuation from its own exact task/environment history, not caller-supplied MR ids, and automatically keeps original title/body despite changed new report defaults. An ordinary non-force fast-forward push requires observed remote prior SHA and local ancestry; publication of a continuation performs exact MR GET readback without POST/PUT. Closed, merged or edited original MRs block continuation. Unknown attempts are not replayed. Stale historical verification preserves the original verifiedAt proof without falsely making the stale preview current.

Meegle 5 owns source-neutral execution; its taskList capabilities declare workflowVersion2/technicalTasks/analysisTasks. GitLab Client navigation service is effect-owned `gitlabNavigation:{startWork(seed),openTask(taskId),openRepository({connectionId,projectId})}`. Meegle's reciprocal optional `meegleNavigation` supports openTask/openWorkItem/openSettings. Neither Client service grants Host mutation authority.

## Existing provider and transport contract

## `gitlabWorkspace` optional Cordis service

Resolve with `ctx.get('gitlabWorkspace')`; check for absence. Methods return raw values or throw stable errors (no transport envelope). Cordis 4 requires `ctx.provide` for initial service registration; `ctx.set` can only overwrite a service already provided by the same fiber. The frozen facade is registered/disposed with the plugin and exposes only these methods:

- `capabilities()` → `{provider,executionModes,deliveryPolicies,nativeWorktrees,credentials,durableStorage,autoFetch:false,autoPush:false,worktreeIsSandbox:false}`.
- `plan(codeTarget)` → `{id,hash,codeTarget,sourceRoot,baseCommit,baseRef,remote,project,identityId,warnings}`. No fetch; recomputed before preparation.
- `prepare({taskId,preparationId,sessionId,codeTarget,plan})` → environment. Host callers must have obtained user approval for the plan and be authorized to use the exact session. No model prompts are issued.
- `getEnvironment(id)` → stored environment.
- `assertEnvironment({environmentId,sessionId})` → environment, after exact session, cwd, canonical worktree path, branch and project-remote validation. Does not require a clean worktree during active development.
- `prepareDelivery({environmentId,taskId,resultRevision,title,description})` → frozen delivery preview. Requires clean committed worktree and matching task. `resultRevision` is an integer ≥ 0 or a bounded revision identifier. The consuming task service must compare it with its current report revision before confirmation/acceptance.
- `pushDelivery({deliveryId,confirm:true})` → delivery (`pushed` after remote SHA readback). Trusted Host consumer must enforce actual browser-user confirmation for this exact preview; a boolean is not authentication.
- `publishDraft({deliveryId,confirm:true})` → delivery (`verified` only after exact MR+branch+local readback). Same Host authority requirement.
- `verifyDelivery({deliveryId})` → readback-reconciled delivery; never writes GitLab. Throws and marks unknown if local preview/session binding changed.
- `getDelivery(id)` → stored delivery, not a fresh attestation. Call `verifyDelivery` at acceptance boundaries.

`codeTarget`:

```json
{"provider":"gitlab","connectionId":"connection-…","projectId":"123","checkoutId":"checkout-…","subdirectory":"app","targetBranch":"main","executionMode":"new-worktree","deliveryPolicy":"draft-mr-manual"}
```

Project ids normalize to strings. Root subdirectory defaults to `""`. All source refs must already exist locally.

Environment fields: `{id,state:'preparing'|'ready'|'unknown',taskId,preparationId,sessionId,codeTarget,planHash,sourceRoot,branch,baseCommit,createdAt,path?,worktreePath?,executionCwd?}`. Ready environments have all three directory fields, with `path === worktreePath` and `executionCwd` the exact canonical selected subdirectory. Non-ready records can describe retained artifacts; do not assume retry is safe.

Delivery fields: `{id,state:'prepared'|'pushing'|'pushed'|'publishing'|'verified'|'unknown',environmentId,taskId,resultRevision,headSha,title,description,marker,sourceBranch,targetBranch,connectionId,projectId,remote,project,createdAt,intent?,mr?}`. `intent` is `push` or `publish`. `mr` contains `{id,iid,title,description,sourceBranch,targetBranch,sha,state,draft,webUrl}`. Stored `verified` is historical; verification at a later acceptance boundary may fail due to local or remote changes.

## Authenticated browser/API transport

`POST /api/gitlab-panel`, JSON body `{action,...arguments}`. DSH `connection.admit(request)` authenticates every request before its body is parsed. Only the admitted peer whose id equals `connection.browserPeer.id` has user authority. API peers and agent tools cannot authorize mutations by supplying `confirm:true`, fake caller fields or another peer id.

Responses: `{ok:true,data:payload}` or `{ok:false,error:{code,message}}`. Authentication/media/body errors use HTTP 401/403, 415 or 413 as appropriate. Application failures use the same JSON error envelope. Request size ≤ 64KiB; API response body ≤ 1MiB; Git output ≤ 256KiB; API calls time out at 15s; local checks at 10s; push at 60s. Collections are capped to the newest 200 stored records; remote pages contain at most 30 items, pages 1..100. Remote pagination's `hasMore` conservatively means a full 30-item page (the next page may be empty).

Read operations:

- `status` → `{connections,checkouts,environments,deliveries,capabilities}`. Connections include frozen identity and non-secret credential presence.
- `projects {connectionId,search?,page?}`; `branches {connectionId,projectId,page?}`; `mergeRequests {connectionId,projectId,page?}` → `{items,page,hasMore}`. MRs are opened only.
- `checkouts`, `environments`, `deliveries` → `{items}`.
- `getEnvironment {environmentId}`, `getDelivery {deliveryId}` → stored singular payload under `data`; no local filesystem inspection or session activation.

User-only operations (also available through the trusted raw Host service to scoped execution workflows):

- `plan {codeTarget}`, `assertEnvironment {environmentId,sessionId}`, `verifyDelivery {deliveryId}` → raw singular payload under `data`. These can inspect local Git or resolve/resume a session, so arbitrary agents/API peers cannot invoke them.

- `saveConnection {name,baseUrl,token,id?}` → connection. Updating keeps original base URL and numeric user id; another account requires a new connection. PAT must be nonempty, without whitespace, ≤ 4096 characters.
- `disconnect {connectionId,confirm:true}` → `{disconnected:true,connectionId}`. Metadata becomes disconnected before credential deletion; partial failure is surfaced and not silently marked successful.
- `bindCheckout {connectionId,projectId,path,confirm:true}` → checkout `{id,connectionId,projectId,path,defaultBranch,project,remote,createdAt}`.
- `prepare`, `prepareDelivery`, `pushDelivery`, `publishDraft` take the same object arguments as the raw provider methods.

Project public shape: `{id,name,pathWithNamespace,defaultBranch,webUrl}`. Branch shape: `{name,default,protected,commit:{id}}`. Remote shape: `{name,fetchUrl,pushUrl}`; credential-bearing HTTPS URLs and password-bearing SSH URLs are rejected.

`gitlab_workbench` exposes remote read operations and stored metadata only. Planning, session assertions and reconciliation are not exposed to unbound agents/API peers, even though they do not publish GitLab changes: their local filesystem/session access belongs to the user or a correctly scoped execution adapter. Credential mutation, binding, native preparation, delivery preparation and publication also stay behind that authority boundary.

## Failure and recovery

Errors intentionally omit response bodies, raw exception text, stderr and credentials. Important codes include `USER_ONLY`, `CONFIRM_REQUIRED`, `IDENTITY_CHANGED`, `REMOTE_MISMATCH`, `REMOTE_CHANGED`, `LOCAL_REF_MISSING`, `PLAN_STALE`, `PREPARATION_UNKNOWN`, `CWD_MISMATCH`, `HEAD_CHANGED`, `DELIVERY_UNKNOWN`, `REMOTE_BRANCH_EXISTS`, `MR_EXISTS`, `NETWORK_UNKNOWN`, `PUSH_UNKNOWN`, `MR_UNKNOWN`. Inspect stored records and the exact bound session/GitLab MR. Do not switch accounts, create another preparation id, or repeat a remote write to disguise an uncertain result.
