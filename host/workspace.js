import { GitLabApi, mrView } from './api.js'
import { domainSpec, schemas, targetSchema } from './storage.js'
import { fail, identifier, projectId, baseUrl, text, uid, hash, confirm, branch, subdirectory } from './security.js'
import * as nativeGit from './git.js'
const now = () => new Date().toISOString()
const copy = value => structuredClone(value)
/** Host application service: raw values on success; stable PanelError on failure. */
export class GitLabWorkspace {
  constructor(ctx, { api, git = nativeGit } = {}) { this.ctx = ctx; this.api = api ?? new GitLabApi({ credentials: ctx.get('credentials') }); this.git = git; this.opening = null; this.domain = null; this.queue = Promise.resolve(); this.disposed = false }
  async ready() { if (this.disposed) fail('DISPOSED', 'GitLab plugin is unloaded'); if (!this.opening) this.opening = this.ctx.get('storageDomain').open(domainSpec).then(domain => { this.domain = domain; for (const name of Object.keys(schemas)) for (const [key, value] of domain.table(name).entries()) if (value.id !== key) fail('INVALID_STORAGE', 'Stored record identity mismatch'); return domain }); return this.opening }
  async serial(fn) { const pending = this.queue.then(() => { if (this.disposed) fail('DISPOSED', 'GitLab plugin is unloaded'); return fn() }); this.queue = pending.catch(() => {}); return pending }
  table(name) { return this.domain.table(name) }
  async get(name, id) { await this.ready(); const value = this.table(name).get(identifier(id)); if (!value) fail('NOT_FOUND', `${name} record not found`); return copy(value) }
  async put(name, value) { schemas[name].parse(value); await this.table(name).put(value.id, copy(value)); return copy(value) }
  async list(name) { await this.ready(); const values = [...this.table(name).entries()].map(([, value]) => copy(value)); return values.slice(-200).reverse() }
  async connection(id) { const c = await this.get('connections', id); if (c.state !== 'connected') fail('DISCONNECTED', 'Reconnect the original GitLab identity'); return c }
  capabilities() { return { provider: 'gitlab', workflowVersion: 2, environmentInspection: true, reviewFacts: true, sameMrContinuation: true, worktreeAvailability: 'resolved-at-session-start', executionModes: ['new-worktree'], deliveryPolicies: ['draft-mr-manual'], nativeWorktrees: Boolean(this.ctx.get('worktrees')), credentials: Boolean(this.ctx.get('credentials')), durableStorage: Boolean(this.ctx.get('storageDomain')), autoFetch: false, autoPush: false, worktreeIsSandbox: false } }
  async status() { await this.ready(); const connections = await this.list('connections'); for (const c of connections) c.credentialConfigured = (await this.ctx.get('credentials').describeRecord(this.api.key(c.id))).configured; return { connections, checkouts: await this.list('checkouts'), environments: await this.list('environments'), deliveries: await this.list('deliveries'), capabilities: this.capabilities() } }
  saveConnection(input) { return this.serial(async () => {
    await this.ready(); const id = input.id ? identifier(input.id) : uid('connection'); const previous = this.table('connections').get(id); if (input.id && !previous) fail('NOT_FOUND', 'Connection not found'); const c = { id, name: text(input.name, 'name', 100), baseUrl: baseUrl(input.baseUrl), createdAt: previous?.createdAt ?? now(), state: 'connected' }
    const token = text(input.token, 'PAT', 4096); if (/\s/.test(token)) fail('INVALID_ARGUMENT', 'PAT cannot contain whitespace'); if (previous && previous.baseUrl !== c.baseUrl) fail('CONNECTION_IMMUTABLE', 'Create a new connection for another GitLab base URL'); c.identity = await this.api.identity(c, token); if (previous && previous.identity.id !== c.identity.id) fail('IDENTITY_CHANGED', 'Create a new connection for another GitLab user'); await this.ctx.get('credentials').modifyRecord(this.api.key(id), async () => ({ kind: 'api-key', key: token })); return this.put('connections', c)
  }) }
  disconnect(input) { return this.serial(async () => { confirm(input.confirm); const c = await this.get('connections', input.connectionId); await this.put('connections', { ...c, state: 'disconnected' }); await this.ctx.get('credentials').deleteRecord(this.api.key(c.id)); return { disconnected: true, connectionId: c.id } }) }
  async projects(input) { const c = await this.connection(input.connectionId); return this.api.projects(c, input.search, input.page) }
  async branches(input) { const c = await this.connection(input.connectionId); return this.api.branches(c, input.projectId, input.page) }
  async mergeRequests(input) { const c = await this.connection(input.connectionId); return this.api.mergeRequests(c, input.projectId, input.page) }
  async readReview(input) { const c = await this.connection(input.connectionId); return this.api.readReview(c, input.projectId, input.mrIid) }
  review(input) { return this.readReview(input) }
  async reviewRequests(input) { const c = await this.connection(input.connectionId); return this.api.reviewRequests(c, input.page) }
  async inspectEnvironment(input) {
    const env = await this.getEnvironment(input.environmentId)
    await this.assertEnvironment({ environmentId: env.id, sessionId: env.sessionId })
    const observed = await this.git.inspect(env.worktreePath, env.baseCommit)
    await this.assertEnvironment({ environmentId: env.id, sessionId: env.sessionId })
    return { environmentId: env.id, ...observed, observedAt: now() }
  }
  bindCheckout(input) { return this.serial(async () => { confirm(input.confirm); const c = await this.connection(input.connectionId); await this.api.assertIdentity(c); const project = await this.api.project(c, projectId(input.projectId)); const path = await this.git.root(input.path); const remote = await this.git.remote(path, c, project); const existing = (await this.list('checkouts')).find(item => item.path === path && item.connectionId === c.id && item.projectId === project.id); return this.put('checkouts', { id: existing?.id ?? uid('checkout'), connectionId: c.id, projectId: project.id, path, defaultBranch: project.defaultBranch, project, remote, createdAt: existing?.createdAt ?? now() }) }) }
  async plan(codeTarget) {
    let target; try { target = targetSchema.parse(codeTarget) } catch { fail('INVALID_TARGET', 'Select a GitLab connection, project, bound checkout, target branch and new-worktree/manual Draft MR policy') }; target.targetBranch = branch(target.targetBranch); target.subdirectory = subdirectory(target.subdirectory)
    const c = await this.connection(target.connectionId), checkout = await this.get('checkouts', target.checkoutId)
    if (checkout.connectionId !== c.id || checkout.projectId !== target.projectId) fail('TARGET_MISMATCH', 'Checkout binding does not match the selected connection and project')
    const sourceRoot = await this.git.root(checkout.path); await this.git.contained(sourceRoot, target.subdirectory); const remote = await this.git.remote(sourceRoot, c, checkout.project, checkout.remote.name); if (hash(remote) !== hash(checkout.remote)) fail('REMOTE_CHANGED', 'Remote changed since checkout binding; bind it again')
    const base = await this.git.localBase(sourceRoot, remote.name, target.targetBranch); const body = { codeTarget: target, sourceRoot, baseCommit: base.sha, baseRef: base.ref, remote, project: checkout.project, identityId: c.identity.id }
    const digest = hash(body); return { id: `plan-${digest.slice(0, 32)}`, hash: digest, ...body, warnings: ['Local refs only; no automatic fetch.', 'Worktree is not a security sandbox. Session permissions remain unchanged.'] }
  }
  prepare(input) { return this.serial(async () => {
    const taskId = identifier(input.taskId, 'taskId'), preparationId = identifier(input.preparationId, 'preparationId'), sessionId = identifier(input.sessionId, 'sessionId'); await this.ready()
    const prior = [...this.table('environments').entries()].map(([, v]) => v).find(e => e.preparationId === preparationId)
    if (prior) { if (prior.taskId !== taskId || prior.sessionId !== sessionId || prior.planHash !== input.plan?.hash) fail('PREPARATION_CONFLICT', 'Preparation identity was already used for a different target'); if (prior.state !== 'ready') fail('PREPARATION_UNKNOWN', 'Preparation may have retained artifacts; inspect the original session and worktree, do not repeat automatically'); return copy(prior) }
    if ([...this.table('environments').entries()].some(([, e]) => e.sessionId === sessionId)) fail('SESSION_BOUND', 'This session already owns an environment')
    const plan = await this.plan(input.codeTarget); if (input.plan?.hash !== plan.hash || input.plan?.id !== plan.id) fail('PLAN_STALE', 'Execution plan changed; review a fresh plan before preparation')
    const resolved = await this.ctx.get('sessionController')?.resolveAgent(sessionId); if (!resolved?.agent) fail('SESSION_UNAVAILABLE', 'The exact target session could not be resolved'); const agent = resolved.agent
    // Native services may be mounted on the resolved Session's preset, not the root plugin.
    const worktrees = agent.ctx?.get?.('worktrees') ?? this.ctx.get('worktrees'), wd = agent.ctx?.get?.('workingDirectory') ?? this.ctx.get('workingDirectory'); if (!worktrees || !wd) fail('WORKTREE_UNAVAILABLE', 'The selected session preset must provide native worktree and working-directory services')
    const c = await this.connection(plan.codeTarget.connectionId); await this.api.assertIdentity(c)
    const environment = { id: uid('environment'), state: 'preparing', taskId, preparationId, sessionId, codeTarget: plan.codeTarget, planHash: plan.hash, sourceRoot: plan.sourceRoot, branch: `dsh/gitlab-${hash({ taskId, preparationId }).slice(0, 24)}`, baseCommit: plan.baseCommit, createdAt: now() }
    await this.put('environments', environment)
    try {
      await wd.set(agent, plan.sourceRoot)
      const created = await worktrees.create(agent, { name: environment.branch, from: plan.baseCommit })
      environment.path = created.path; environment.worktreePath = created.path; environment.branch = created.branch
      // Persist the allocated artifact before resolving a possibly absent subdirectory.
      await this.put('environments', environment)
      if (created.baseCommit !== plan.baseCommit || created.repositoryRoot !== plan.sourceRoot) fail('WORKTREE_MISMATCH', 'Native worktree did not match the pinned source and commit')
      environment.executionCwd = await this.git.contained(created.path, plan.codeTarget.subdirectory)
      if (await wd.set(agent, environment.executionCwd) !== environment.executionCwd) fail('CWD_MISMATCH', 'Session execution directory differs from the reviewed subdirectory')
      environment.state = 'ready'; return this.put('environments', environment)
    } catch (error) { environment.state = 'unknown'; await this.put('environments', environment); throw error }
  }) }
  getEnvironment(id) { return this.get('environments', id) }
  async assertEnvironment({ environmentId, sessionId }) {
    const env = await this.getEnvironment(environmentId); if (env.state !== 'ready' || env.sessionId !== sessionId) fail('ENVIRONMENT_MISMATCH', 'Environment is not ready or belongs to another session')
    const resolved = await this.ctx.get('sessionController')?.resolveAgent(sessionId); if (!resolved?.agent) fail('SESSION_UNAVAILABLE', 'Bound session is unavailable')
    const agent = resolved.agent, wd = agent.ctx?.get?.('workingDirectory') ?? this.ctx.get('workingDirectory'); if (!wd || await wd.ensure(agent) !== env.executionCwd) fail('CWD_MISMATCH', 'Session left the exact bound execution directory')
    if (await this.git.root(env.worktreePath) !== env.worktreePath || await this.git.contained(env.worktreePath, env.codeTarget.subdirectory) !== env.executionCwd) fail('ENVIRONMENT_MISMATCH', 'Bound worktree path changed')
    if (await this.git.git(env.worktreePath, ['symbolic-ref', '--short', 'HEAD']) !== env.branch) fail('HEAD_CHANGED', 'Bound environment branch changed')
    const c = await this.connection(env.codeTarget.connectionId), checkout = await this.get('checkouts', env.codeTarget.checkoutId); await this.git.remote(env.worktreePath, c, checkout.project, checkout.remote.name)
    return env
  }
  prepareDelivery(input) { return this.serial(async () => {
    const env = await this.getEnvironment(input.environmentId); if (env.taskId !== input.taskId) fail('TASK_MISMATCH', 'Delivery task does not own the environment'); await this.assertEnvironment({ environmentId: env.id, sessionId: env.sessionId })
    if (!(Number.isSafeInteger(input.resultRevision) && input.resultRevision >= 0) && !(typeof input.resultRevision === 'string' && /^[A-Za-z0-9_.:-]{1,160}$/.test(input.resultRevision))) fail('INVALID_ARGUMENT', 'resultRevision must identify the exact execution report revision')
    let title = text(text(input.title, 'title', 256).replace(/^(?:Draft:|WIP:)\s*/i, ''), 'title body', 240), description = text(input.description || 'Execution report attached by the user.', 'description', 8000)
    const headSha = await this.git.cleanHead(env.worktreePath, env.branch); if (headSha === env.baseCommit) fail('NO_CHANGES', 'Environment has no new commit to deliver'); await this.git.git(env.worktreePath, ['merge-base', '--is-ancestor', env.baseCommit, headSha])
    const checkout = await this.get('checkouts', env.codeTarget.checkoutId), c = await this.connection(env.codeTarget.connectionId); const remote = await this.git.remote(env.worktreePath, c, checkout.project, checkout.remote.name)
    const previous = [...this.table('deliveries').entries()].map(([, v]) => v).filter(d => d.environmentId === env.id).sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    const history = previous.filter(d => d.mr && (d.state === 'verified' || d.verifiedAt) && d.mr.sha === d.headSha)
    if (history.length) { title = history.at(-1).title.replace(/^Draft:\s*/i, ''); description = history.at(-1).description }
    for (const d of previous) { if (d.resultRevision === input.resultRevision && d.headSha === headSha && d.title === `Draft: ${title}` && d.description === description) return copy(d); if (['pushing', 'publishing', 'unknown'].includes(d.state) && !(d.verifiedAt && d.mr && d.mr.sha === d.headSha)) fail('DELIVERY_UNKNOWN', 'Verify the prior uncertain delivery before preparing another') }
    let continuation = {}
    if (history.length) {
      const prior = history.at(-1)
      const mr = await this.exactDeliveryMr(c, prior)
      if (!this.matches(prior, mr)) fail('CONTINUATION_MISMATCH', 'Original MR is closed, merged or changed; continuation is forbidden')
      const observed = await this.api.remoteBranch(c, checkout.projectId, env.branch)
      if (prior.headSha !== observed?.commit?.id) fail('REMOTE_HEAD_CHANGED', 'Remote branch no longer matches latest verified delivery history')
      if (prior.headSha === headSha) fail('NO_CHANGES', 'No new commit since the verified MR')
      if (prior.taskId !== env.taskId || prior.sourceBranch !== env.branch || prior.targetBranch !== env.codeTarget.targetBranch || prior.connectionId !== c.id || prior.projectId !== checkout.projectId || hash(prior.remote) !== hash(remote)) fail('CONTINUATION_MISMATCH', 'Verified delivery does not match this exact task and environment target')
      await this.git.git(env.worktreePath, ['merge-base', '--is-ancestor', prior.headSha, headSha])
      continuation = { priorDeliveryId: prior.id, priorHeadSha: prior.headSha, priorMR: mr, marker: prior.marker, raceLimits: ['Continuation retains the original MR title and body; requested replacement title/body are ignored and the returned preview is authoritative.', 'Remote and MR checks are observations, not locks. A concurrent non-fast-forward update is rejected by Git; a concurrent ancestor update may be accepted by ordinary fast-forward push.', 'MR state may change after inspection. No MR edit is performed; post-push readback must still match.'] }
    }
    const id = uid('delivery'); return this.put('deliveries', { id, state: 'prepared', environmentId: env.id, taskId: env.taskId, resultRevision: input.resultRevision, headSha, title: `Draft: ${title}`, description, marker: `<!-- dsh-gitlab-delivery:${id} -->`, sourceBranch: env.branch, targetBranch: env.codeTarget.targetBranch, connectionId: c.id, projectId: checkout.projectId, remote, project: checkout.project, createdAt: now(), ...continuation })
  }) }
  getDelivery(id) { return this.get('deliveries', id) }
  async exactDeliveryMr(c, d) {
    const expected = d.priorMR ?? d.mr
    if (!expected) fail('CONTINUATION_MISMATCH', 'Original MR identity is missing')
    const mr = mrView(await this.api.request(c, `/projects/${d.projectId}/merge_requests/${expected.iid}`), c.baseUrl)
    if (mr.id !== expected.id || mr.iid !== expected.iid) fail('CONTINUATION_MISMATCH', 'Original MR identity changed')
    return mr
  }
  async checkContinuation(d, env, c, expectedHead) {
    const prior = await this.getDelivery(d.priorDeliveryId)
    if (prior.environmentId !== d.environmentId || prior.taskId !== d.taskId || prior.headSha !== d.priorHeadSha || !(prior.state === 'verified' || prior.verifiedAt) || hash(prior.mr) !== hash(d.priorMR) || ['marker', 'sourceBranch', 'targetBranch', 'connectionId', 'projectId', 'title', 'description'].some(k => prior[k] !== d[k]) || hash(prior.remote) !== hash(d.remote)) fail('CONTINUATION_MISMATCH', 'Frozen prior delivery binding changed')
    await this.git.git(env.worktreePath, ['merge-base', '--is-ancestor', d.priorHeadSha, d.headSha])
    const mr = await this.exactDeliveryMr(c, d)
    if (!this.matches({ ...d, headSha: expectedHead }, mr)) fail('CONTINUATION_MISMATCH', 'Original MR is closed, merged or no longer matches its frozen preview')
    return mr
  }
  async checkedDelivery(id) { const d = await this.getDelivery(id), env = await this.getEnvironment(d.environmentId); await this.assertEnvironment({ environmentId: env.id, sessionId: env.sessionId }); if (await this.git.cleanHead(env.worktreePath, d.sourceBranch) !== d.headSha) fail('HEAD_CHANGED', 'Delivery preview is stale; prepare a new preview for the current commit'); const c = await this.connection(d.connectionId); await this.api.assertIdentity(c); const remote = await this.git.remote(env.worktreePath, c, d.project, d.remote.name); if (hash(remote) !== hash(d.remote)) fail('REMOTE_CHANGED', 'Delivery remote changed; review a new preview'); return { d, env, c } }
  pushDelivery(input) { return this.serial(async () => {
    confirm(input.confirm); const { d, env, c } = await this.checkedDelivery(input.deliveryId)
    if (['pushed', 'verified'].includes(d.state)) return d
    if (d.state !== 'prepared') fail('DELIVERY_UNKNOWN', 'This push may already have run; verify before any further write')
    if (d.priorMR) await this.checkContinuation(d, env, c, d.priorHeadSha)
    const existing = await this.api.remoteBranch(c, d.projectId, d.sourceBranch)
    if (d.priorMR) { if (existing?.commit?.id !== d.priorHeadSha) fail('REMOTE_HEAD_CHANGED', 'Continuation remote must still equal the verified prior head; no overwrite is permitted') }
    else if (existing) { if (existing.commit?.id === d.headSha) return this.put('deliveries', { ...d, state: 'pushed' }); fail('REMOTE_BRANCH_EXISTS', 'Source branch already exists at another commit; no overwrite is permitted') }
    await this.put('deliveries', { ...d, state: 'pushing', intent: 'push' })
    try { await this.git.git(env.worktreePath, ['push', '--porcelain', '--no-verify', '--', d.remote.name, `${d.headSha}:refs/heads/${d.sourceBranch}`], { push: true }); const observed = await this.api.remoteBranch(c, d.projectId, d.sourceBranch); if (observed?.commit?.id !== d.headSha) fail('PUSH_UNKNOWN', 'Pushed branch could not be confirmed at the pinned SHA'); return this.put('deliveries', { ...d, state: 'pushed', intent: 'push' }) }
    catch (error) { await this.put('deliveries', { ...d, state: 'unknown', intent: 'push' }); throw error }
  }) }
  publishDraft(input) { return this.serial(async () => {
    confirm(input.confirm); const { d, env, c } = await this.checkedDelivery(input.deliveryId)
    if (d.state === 'verified') return d
    if (d.state !== 'pushed') fail('DELIVERY_UNKNOWN', 'Push and verify the pinned branch before publishing; uncertain publication cannot be repeated')
    const remote = await this.api.remoteBranch(c, d.projectId, d.sourceBranch); if (remote?.commit?.id !== d.headSha) fail('REMOTE_HEAD_CHANGED', 'Remote source branch no longer matches the reviewed SHA')
    if (d.priorMR) {
      try {
        const mr = await this.checkContinuation(d, env, c, d.headSha)
        const head = await this.api.remoteBranch(c, d.projectId, d.sourceBranch)
        if (head?.commit?.id !== d.headSha) fail('REMOTE_HEAD_CHANGED', 'Remote changed during continuation readback')
        await this.checkedDelivery(d.id)
        return this.put('deliveries', { ...d, state: 'verified', intent: 'publish', mr, verifiedAt: now() })
      } catch (error) { await this.put('deliveries', { ...d, state: 'unknown', intent: 'publish' }); throw error }
    }
    const existing = await this.api.mergeRequests(c, d.projectId, 1, d.sourceBranch); if (existing.length) fail('MR_EXISTS', 'Source branch already has an open MR; inspect it instead of creating another')
    await this.put('deliveries', { ...d, state: 'publishing', intent: 'publish' })
    try {
      const raw = await this.api.request(c, `/projects/${d.projectId}/merge_requests`, { method: 'POST', body: { source_branch: d.sourceBranch, target_branch: d.targetBranch, title: d.title, description: `${d.description}\n\n${d.marker}`, remove_source_branch: false } })
      if (!Number.isSafeInteger(raw.iid) || raw.iid < 1) fail('MR_UNKNOWN', 'Created MR identity could not be read back')
      const mr = mrView(await this.api.request(c, `/projects/${d.projectId}/merge_requests/${raw.iid}`), c.baseUrl)
      const head = await this.api.remoteBranch(c, d.projectId, d.sourceBranch)
      if (!this.matches(d, mr) || head?.commit?.id !== d.headSha) fail('MR_UNKNOWN', 'MR readback did not match the frozen delivery preview')
      await this.checkedDelivery(d.id)
      return this.put('deliveries', { ...d, state: 'verified', intent: 'publish', mr, verifiedAt: now() })
    }
    catch (error) { await this.put('deliveries', { ...d, state: 'unknown', intent: 'publish' }); throw error }
  }) }
  matches(d, mr) { return mr.draft && mr.sourceBranch === d.sourceBranch && mr.targetBranch === d.targetBranch && mr.sha === d.headSha && mr.title === d.title && mr.description === `${d.description}\n\n${d.marker}` && mr.state === 'opened' }
  verifyDelivery(input) { return this.serial(async () => {
    const d = await this.getDelivery(input.deliveryId)
    let c, env; try { ({ c, env } = await this.checkedDelivery(d.id)) } catch (error) { await this.put('deliveries', { ...d, state: 'unknown', ...(d.state === 'verified' ? { verifiedAt: d.verifiedAt ?? now() } : {}) }); throw error }
    const remote = await this.api.remoteBranch(c, d.projectId, d.sourceBranch)
    if (d.priorMR) {
      try {
        const mr = await this.checkContinuation(d, env, c, d.headSha)
        if (remote?.commit?.id === d.headSha) return this.put('deliveries', { ...d, state: 'verified', mr, verifiedAt: now() })
      } catch { /* An unavailable or mismatching exact MR never unlocks a retry. */ }
      return this.put('deliveries', { ...d, state: 'unknown' })
    }
    const mrs = await this.api.mergeRequests(c, d.projectId, 1, d.sourceBranch), matching = mrs.filter(m => this.matches(d, m))
    if (remote?.commit?.id === d.headSha && matching.length === 1) return this.put('deliveries', { ...d, state: 'verified', mr: matching[0], verifiedAt: now() })
    if (remote?.commit?.id === d.headSha && d.intent !== 'publish' && !mrs.length) return this.put('deliveries', { ...d, state: 'pushed' })
    // Absence is not proof that an in-flight write failed; never unlock a repeat.
    if (d.state === 'prepared' && !remote && !mrs.length) return d
    return this.put('deliveries', { ...d, state: 'unknown' })
  }) }
  async dispose() { this.disposed = true; await this.queue; if (this.opening) await this.opening.catch(() => {}); await this.domain?.close() }
}
