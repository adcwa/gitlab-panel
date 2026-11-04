import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { GitLabWorkspace } from '../host/workspace.js'
import { domainSpec } from '../host/storage.js'
import * as git from '../host/git.js'

function memoryDomain() {
  const maps = new Map(Object.keys(domainSpec.tables).map(name => [name, new Map()]))
  return { name: domainSpec.name, close: async () => {}, table(name) { const map = maps.get(name); return { get: key => structuredClone(map.get(key)), entries: () => map.entries(), put: async (key, value) => { domainSpec.tables[name].valueSchema.parse(value); map.set(key, structuredClone(value)) }, delete: async key => map.delete(key) } } }
}
async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'dsh-gitlab-test-')); t.after(async () => { assert.ok(directory.startsWith(path.join(tmpdir(), 'dsh-gitlab-test-'))); await rm(directory, { recursive: true, force: true }) })
  const source = path.join(directory, 'source'); await mkdir(source); await git.git(source, ['init', '-b', 'main']); await git.git(source, ['config', 'user.email', 'test@example.invalid']); await git.git(source, ['config', 'user.name', 'Test']); await mkdir(path.join(source, 'app')); await writeFile(path.join(source, 'app', 'file.txt'), 'base'); await git.git(source, ['add', '.']); await git.git(source, ['commit', '-m', 'base']); await git.git(source, ['remote', 'add', 'origin', 'git@git.example:group/repo.git'])
  const canonical = await git.root(source), domain = memoryDomain(), records = new Map(), agents = new Map([['session-1', { id: 'session-1' }]]), cwd = new Map([['session-1', canonical]])
  let worktreeCalls = 0, pushCalls = 0, mrCalls = 0, branchRow = null, mrs = [], postUnknown = false, pushUnknown = false, identityId = 42
  const credentials = { describeRecord: async key => ({ configured: records.has(key) }), modifyRecord: async (key, fn) => records.set(key, await fn(records.get(key))), readRecord: async key => records.get(key), deleteRecord: async key => records.delete(key) }
  const services = { credentials, storageDomain: { open: async () => domain }, sessionController: { resolveAgent: async id => agents.has(id) ? { agent: agents.get(id) } : { error: Error('not found') } }, workingDirectory: { set: async (agent, value) => { cwd.set(agent.id, value); return value }, ensure: async agent => cwd.get(agent.id) }, worktrees: { create: async (agent, request) => { worktreeCalls++; const target = path.join(directory, `tree-${worktreeCalls}`); await git.git(cwd.get(agent.id), ['worktree', 'add', '-b', request.name, target, request.from]); return { path: await git.root(target), branch: request.name, baseCommit: request.from, repositoryRoot: canonical } } } }
  const api = { key: id => `local.gitlab-panel.${id}`, identity: async () => ({ id: identityId, username: 'tester', name: 'Tester' }), assertIdentity: async c => { if (c.identity.id !== identityId) throw Object.assign(Error('identity changed'), { code: 'IDENTITY_CHANGED' }) }, project: async () => ({ id: '123', name: 'Repo', pathWithNamespace: 'group/repo', defaultBranch: 'main', webUrl: 'https://git.example/group/repo' }), remoteBranch: async () => branchRow, mergeRequests: async () => mrs, request: async (_c, _p, options) => { if (!options?.body) { const m = mrs[0]; return { ...m, source_branch: m.sourceBranch, target_branch: m.targetBranch, web_url: m.webUrl } }; mrCalls++; const body = options.body; const row = { id: 1, iid: 1, title: body.title, description: body.description, source_branch: body.source_branch, target_branch: body.target_branch, sha: branchRow.commit.id, state: 'opened', draft: true, web_url: 'https://git.example/group/repo/-/merge_requests/1' }; mrs = [{ id: row.id, iid: row.iid, title: row.title, description: row.description, sourceBranch: row.source_branch, targetBranch: row.target_branch, sha: row.sha, state: 'opened', draft: true, webUrl: row.web_url }]; if (postUnknown) throw Error('lost response'); return row } }
  const safeGit = { ...git, git: async (directory, args, options) => { if (args[0] === 'push') { pushCalls++; branchRow = { commit: { id: args.at(-1).split(':')[0] } }; if (pushUnknown) throw Error('lost push response'); assert.ok(!args.some(a => a.includes('force'))); return '' }; return git.git(directory, args, options) } }
  const ctx = { get: key => services[key] }, service = new GitLabWorkspace(ctx, { api, git: safeGit })
  const connection = await service.saveConnection({ name: 'GitLab', baseUrl: 'https://git.example', token: 'fake-token' }); const checkout = await service.bindCheckout({ connectionId: connection.id, projectId: '123', path: canonical, confirm: true })
  const codeTarget = { provider: 'gitlab', connectionId: connection.id, projectId: '123', checkoutId: checkout.id, subdirectory: 'app', targetBranch: 'main', executionMode: 'new-worktree', deliveryPolicy: 'draft-mr-manual' }
  const prepare = async (overrides = {}) => service.prepare({ taskId: 'task-1', preparationId: 'preparation-1', sessionId: 'session-1', codeTarget, plan: await service.plan(codeTarget), ...overrides })
  async function committedEnvironment() { const env = await prepare(); await writeFile(path.join(env.executionCwd, 'file.txt'), 'changed'); await git.git(env.worktreePath, ['add', '.']); await git.git(env.worktreePath, ['commit', '-m', 'task change']); return env }
  return { service, ctx, api, safeGit, codeTarget, prepare, committedEnvironment, domain, cwd, connection, counts: () => ({ worktreeCalls, pushCalls, mrCalls }), setPostUnknown: () => { postUnknown = true }, setPushUnknown: () => { pushUnknown = true }, setIdentity: id => { identityId = id }, setRemote: row => { branchRow = row }, setMrs: rows => { mrs = rows } }
}

test('connection identity frozen, credential never in durable state or status', async t => {
  const f = await fixture(t); f.setIdentity(7)
  await assert.rejects(f.service.saveConnection({ id: f.connection.id, name: 'Other', baseUrl: 'https://git.example', token: 'other-token' }), { code: 'IDENTITY_CHANGED' })
  assert.ok(!JSON.stringify(await f.service.status()).includes('fake-token'))
})
test('plan uses local refs and prepare creates one retained worktree with exact subdirectory', async t => {
  const f = await fixture(t), plan = await f.service.plan(f.codeTarget)
  assert.equal(plan.sourceRoot, (await f.service.get('checkouts', f.codeTarget.checkoutId)).path)
  const env = await f.prepare(); assert.equal(env.state, 'ready'); assert.equal(env.executionCwd, path.join(env.worktreePath, 'app')); assert.equal(f.cwd.get('session-1'), env.executionCwd)
  assert.equal((await f.prepare()).id, env.id); assert.equal(f.counts().worktreeCalls, 1)
  assert.equal((await f.service.assertEnvironment({ environmentId: env.id, sessionId: env.sessionId })).id, env.id)
  await assert.rejects(f.service.assertEnvironment({ environmentId: env.id, sessionId: 'other' }), { code: 'ENVIRONMENT_MISMATCH' })
  f.cwd.set('session-1', plan.sourceRoot); await assert.rejects(f.service.assertEnvironment({ environmentId: env.id, sessionId: env.sessionId }), { code: 'CWD_MISMATCH' })
})
test('stale plan, unsafe subdirectory and missing target fail before worktree allocation', async t => {
  const f = await fixture(t)
  await assert.rejects(f.prepare({ plan: { id: 'old', hash: 'old' } }), { code: 'PLAN_STALE' })
  await assert.rejects(f.service.plan({ ...f.codeTarget, subdirectory: '../escape' }), { code: 'INVALID_SUBDIRECTORY' })
  await assert.rejects(f.service.plan({ ...f.codeTarget, targetBranch: 'not-local' }), { code: 'LOCAL_REF_MISSING' })
  assert.equal(f.counts().worktreeCalls, 0)
})
test('preview pins commit/report; push and Draft publication are separate confirmed writes', async t => {
  const f = await fixture(t), env = await f.committedEnvironment()
  const d = await f.service.prepareDelivery({ environmentId: env.id, taskId: env.taskId, resultRevision: 3, title: 'Task change', description: 'Reviewed report' })
  assert.equal(d.state, 'prepared'); assert.equal(d.resultRevision, 3); assert.match(d.headSha, /^[0-9a-f]{40}$/)
  await assert.rejects(f.service.pushDelivery({ deliveryId: d.id }), { code: 'CONFIRM_REQUIRED' }); assert.equal(f.counts().pushCalls, 0)
  assert.equal((await f.service.pushDelivery({ deliveryId: d.id, confirm: true })).state, 'pushed'); assert.equal(f.counts().mrCalls, 0)
  assert.equal((await f.service.publishDraft({ deliveryId: d.id, confirm: true })).state, 'verified')
  assert.equal((await f.service.verifyDelivery({ deliveryId: d.id })).state, 'verified'); assert.deepEqual(f.counts(), { worktreeCalls: 1, pushCalls: 1, mrCalls: 1 })
})
test('creation response is not trusted without matching GET readback', async t => {
  const f = await fixture(t), env = await f.committedEnvironment(), d = await f.service.prepareDelivery({ environmentId: env.id, taskId: env.taskId, resultRevision: 1, title: 'Change', description: 'Report' })
  await f.service.pushDelivery({ deliveryId: d.id, confirm: true })
  const request = f.api.request; f.api.request = async (...args) => { const result = await request(...args); return args[2]?.body ? result : { ...result, sha: '0'.repeat(40) } }
  await assert.rejects(f.service.publishDraft({ deliveryId: d.id, confirm: true }), { code: 'MR_UNKNOWN' })
  assert.equal((await f.service.getDelivery(d.id)).state, 'unknown'); assert.equal(f.counts().mrCalls, 1)
})
test('unknown preparation cannot allocate a second worktree', async t => {
  const f = await fixture(t); const worktrees = f.ctx.get('worktrees'), create = worktrees.create
  worktrees.create = async (...args) => { await create(...args); throw Error('lost native response') }
  await assert.rejects(f.prepare()); assert.equal((await f.service.list('environments'))[0].state, 'unknown')
  await assert.rejects(f.prepare(), { code: 'PREPARATION_UNKNOWN' }); assert.equal(f.counts().worktreeCalls, 1)
})
test('unknown MR outcome is durable across restart and reconciled without repeating writes', async t => {
  const f = await fixture(t), env = await f.committedEnvironment(), d = await f.service.prepareDelivery({ environmentId: env.id, taskId: env.taskId, resultRevision: 1, title: 'Change', description: 'Report' })
  await f.service.pushDelivery({ deliveryId: d.id, confirm: true }); f.setPostUnknown()
  await assert.rejects(f.service.publishDraft({ deliveryId: d.id, confirm: true })); assert.equal((await f.service.getDelivery(d.id)).state, 'unknown')
  const resumed = new GitLabWorkspace(f.ctx, { api: f.api, git: f.safeGit })
  await assert.rejects(resumed.publishDraft({ deliveryId: d.id, confirm: true }), { code: 'DELIVERY_UNKNOWN' }); assert.equal(f.counts().mrCalls, 1)
  assert.equal((await resumed.verifyDelivery({ deliveryId: d.id })).state, 'verified'); assert.equal(f.counts().mrCalls, 1)
})
test('unknown push is not repeated; readback recovers pushed only, never verified', async t => {
  const f = await fixture(t), env = await f.committedEnvironment(), d = await f.service.prepareDelivery({ environmentId: env.id, taskId: env.taskId, resultRevision: 1, title: 'Change', description: 'Report' })
  f.setPushUnknown(); await assert.rejects(f.service.pushDelivery({ deliveryId: d.id, confirm: true })); assert.equal((await f.service.getDelivery(d.id)).state, 'unknown')
  await assert.rejects(f.service.pushDelivery({ deliveryId: d.id, confirm: true }), { code: 'DELIVERY_UNKNOWN' }); assert.equal(f.counts().pushCalls, 1)
  assert.equal((await f.service.verifyDelivery({ deliveryId: d.id })).state, 'pushed'); assert.equal(f.counts().pushCalls, 1)
})
test('verified MR is invalidated by subsequent local head changes', async t => {
  const f = await fixture(t), env = await f.committedEnvironment(), d = await f.service.prepareDelivery({ environmentId: env.id, taskId: env.taskId, resultRevision: 1, title: 'Change', description: 'Report' })
  await f.service.pushDelivery({ deliveryId: d.id, confirm: true }); await f.service.publishDraft({ deliveryId: d.id, confirm: true })
  await git.git(env.worktreePath, ['commit', '--allow-empty', '-m', 'after delivery'])
  await assert.rejects(f.service.verifyDelivery({ deliveryId: d.id }), { code: 'HEAD_CHANGED' })
  assert.equal((await f.service.getDelivery(d.id)).state, 'unknown')
})
test('head mutation invalidates a delivery preview before writes', async t => {
  const f = await fixture(t), env = await f.committedEnvironment(), d = await f.service.prepareDelivery({ environmentId: env.id, taskId: env.taskId, resultRevision: 1, title: 'Change', description: 'Report' })
  await git.git(env.worktreePath, ['commit', '--allow-empty', '-m', 'new head'])
  await assert.rejects(f.service.pushDelivery({ deliveryId: d.id, confirm: true }), { code: 'HEAD_CHANGED' }); assert.equal(f.counts().pushCalls, 0)
})

test('worktree provider resolves native services from exact session preset when absent at root', async t => {
  const f = await fixture(t), rootGet = f.ctx.get.bind(f.ctx), worktrees = rootGet('worktrees')
  const { agent } = await rootGet('sessionController').resolveAgent('session-1')
  agent.ctx = { get: key => key === 'worktrees' ? worktrees : undefined }
  f.ctx.get = key => key === 'worktrees' ? undefined : rootGet(key)
  const plan = await f.service.plan(f.codeTarget)
  const env = await f.service.prepare({ taskId: 'scoped-task', preparationId: 'scoped-prep', sessionId: 'session-1', codeTarget: f.codeTarget, plan })
  assert.equal(env.state, 'ready'); assert.equal(f.counts().worktreeCalls, 1)
})

test('real Meegle Execution interoperates with GitLab provider through pinned worktree and Draft delivery', async t => {
  const { Execution } = await import('../../meegle-panel/host/execution.js')
  const f = await fixture(t), records = new Map(), user = { kind: 'user' }
  let prompts = 0
  const engine = new Execution({
    workbench: { settings: { cliPath: 'meegle' }, connection: () => ({ id: 'meego', profile: 'fixed', host: 'project.feishu.cn' }), guard: async () => {}, raw: async () => ({ exitCode: 0, stdout: JSON.stringify({ work_item_id: '123' }) }) },
    store: { get: id => structuredClone(records.get(id)), entries: () => [...records], put: async (id, value) => records.set(id, structuredClone(value)) },
    gitlab: (method, value) => f.service[method](value),
    sessions: {
      create: async ({ cwd }) => { assert.equal(cwd, (await f.service.plan(f.codeTarget)).sourceRoot); return { sessionId: 'session-1' } },
      setCwd: async ({ sessionId, cwd }) => { f.cwd.set(sessionId, cwd); return cwd },
      prompt: async ({ sessionId, content }) => { prompts++; assert.equal(sessionId, 'session-1'); assert.ok(content.includes(`cwd=${f.cwd.get(sessionId)}`)); assert.equal(records.size, 1) },
    },
  })
  const run = async (action, task, input = {}, caller = user) => {
    const result = await engine.dispatch({ action, ...(task ? { taskId: task.id, expectedVersion: task.version } : {}), ...input }, caller)
    assert.equal(result.ok, true, JSON.stringify(result.error)); return result.data
  }
  let task = await run('taskCreate', null, { connectionId: 'meego', projectKey: 'project', workItemId: '123', objective: 'Test actual provider contract', acceptanceCriteria: 'Pinned Draft MR', scope: { allowCommands: true, allowFileChanges: true }, codeTarget: f.codeTarget })
  task = await run('taskPrepareDispatch', task)
  task = await run('taskDispatch', task, { confirm: true, planId: task.code.plan.id })
  assert.equal(prompts, 1); assert.equal(task.cwd, task.code.environment.executionCwd)
  const env = task.code.environment
  await writeFile(path.join(env.executionCwd, 'file.txt'), 'cross-module change')
  await git.git(env.worktreePath, ['add', '.']); await git.git(env.worktreePath, ['commit', '-m', 'cross-module change'])
  task = await run('taskResult', task, { result: { outcome: 'succeeded', summary: 'Synthetic integration: no real network writes' } }, { kind: 'agent', sessionId: 'session-1' })
  const title = 'x'.repeat(240)
  task = await run('taskPrepareDelivery', task, { resultRevision: task.result.revision, title, description: 'Exact approved body' })
  assert.equal(task.code.delivery.title, `Draft: ${title}`)
  for (const action of ['taskPushDelivery', 'taskPublishDraft']) task = await run(action, task, { resultRevision: task.result.revision, deliveryId: task.code.delivery.id, confirm: true })
  task = await run('taskVerifyDelivery', task, {}, { kind: 'agent', sessionId: 'session-1' })
  assert.equal(task.code.delivery.state, 'verified'); assert.equal(task.code.delivery.mr.draft, true)
  assert.deepEqual(f.counts(), { worktreeCalls: 1, pushCalls: 1, mrCalls: 1 })
  const first = task.code.delivery
  task = await run('taskRequestChanges', task, { notes: 'Refine validation in the same MR' })
  await writeFile(path.join(env.executionCwd, 'file.txt'), 'second cross-module change')
  await git.git(env.worktreePath, ['add', '.']); await git.git(env.worktreePath, ['commit', '-m', 'second cross-module change'])
  task = await run('taskResult', task, { result: { outcome: 'succeeded', summary: 'New report summary must not rewrite the original MR body' } }, { kind: 'agent', sessionId: 'session-1' })
  task = await run('taskPrepareDelivery', task, { resultRevision: task.result.revision })
  assert.equal(task.code.delivery.priorDeliveryId, first.id)
  assert.equal(task.code.delivery.title, first.title); assert.equal(task.code.delivery.description, first.description)
  const originalGit = f.safeGit.git
  f.safeGit.git = async (cwd, args, options) => { const result = await originalGit(cwd, args, options); if (args[0] === 'push') f.setMrs((await f.api.mergeRequests()).map(mr => ({ ...mr, sha: args.at(-1).split(':')[0] }))); return result }
  for (const action of ['taskPushDelivery', 'taskPublishDraft']) task = await run(action, task, { resultRevision: task.result.revision, deliveryId: task.code.delivery.id, confirm: true })
  assert.equal(task.code.delivery.mr.iid, first.mr.iid); assert.notEqual(task.code.delivery.headSha, first.headSha)
  task = await run('taskAccept', task, { resultRevision: task.result.revision, acceptanceNotes: 'Reviewed second revision and fresh MR readback', confirm: true })
  assert.equal(task.status, 'accepted'); assert.equal(task.comment, null)
  assert.deepEqual(f.counts(), { worktreeCalls: 1, pushCalls: 2, mrCalls: 1 })
  await engine.dispose()
})
