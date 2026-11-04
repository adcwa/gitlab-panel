import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { GitLabWorkspace } from '../host/workspace.js'
import { GitLabApi } from '../host/api.js'
import { domainSpec, schemas } from '../host/storage.js'
import { dispatch, toolParameters } from '../host/dispatch.js'
import * as git from '../host/git.js'

async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'gitlab-iteration-'))
  t.after(async () => { assert.ok(path.resolve(directory).startsWith(path.join(tmpdir(), 'gitlab-iteration-'))); await rm(directory, { recursive: true, force: true }) })
  const source = path.join(directory, 'source'); await mkdir(source)
  for (const args of [['init', '-b', 'main'], ['config', 'user.email', 'test@example.invalid'], ['config', 'user.name', 'Test']]) await git.git(source, args)
  await writeFile(path.join(source, 'file.txt'), 'base\n'); await git.git(source, ['add', '.']); await git.git(source, ['commit', '-m', 'base'])
  await git.git(source, ['remote', 'add', 'origin', 'git@git.example:group/repo.git'])
  const root = await git.root(source), tree = path.join(directory, 'tree'), baseCommit = await git.commit(root, 'HEAD')
  await git.git(root, ['worktree', 'add', '-b', 'dsh/task', tree, baseCommit]); const worktreePath = await git.root(tree)
  const maps = new Map(Object.keys(schemas).map(k => [k, new Map()]))
  const domain = { close: async () => {}, table: name => ({ get: id => structuredClone(maps.get(name).get(id)), entries: () => maps.get(name).entries(), put: async (id, value) => { schemas[name].parse(value); maps.get(name).set(id, structuredClone(value)) } }) }
  const project = { id: '123', name: 'Repo', pathWithNamespace: 'group/repo', defaultBranch: 'main', webUrl: 'https://git.example/group/repo' }
  const connection = { id: 'c', name: 'GitLab', baseUrl: 'https://git.example', identity: { id: 42, username: 'tester', name: 'Tester' }, state: 'connected', createdAt: new Date().toISOString() }
  const remote = { name: 'origin', fetchUrl: 'git@git.example:group/repo.git', pushUrl: 'git@git.example:group/repo.git' }
  const codeTarget = { provider: 'gitlab', connectionId: 'c', projectId: '123', checkoutId: 'checkout', subdirectory: '', targetBranch: 'main', executionMode: 'new-worktree', deliveryPolicy: 'draft-mr-manual' }
  const env = { id: 'env', state: 'ready', taskId: 'task', preparationId: 'prep', sessionId: 'session', codeTarget, planHash: 'hash', worktreePath, path: worktreePath, executionCwd: worktreePath, branch: 'dsh/task', baseCommit, sourceRoot: root, createdAt: connection.createdAt }
  let cwd = worktreePath, branchSha = null, rawMr = null, posts = 0, pushes = 0, failPush = false, exactGets = 0
  const agent = { id: 'session', ctx: { get: k => k === 'workingDirectory' ? { ensure: async () => cwd } : undefined } }
  const ctx = { get: key => ({ storageDomain: { open: async spec => { assert.equal(spec.name, domainSpec.name); return domain } }, sessionController: { resolveAgent: async id => id === 'session' ? { agent } : {} } })[key] }
  const api = { assertIdentity: async () => {}, remoteBranch: async () => branchSha ? { commit: { id: branchSha } } : null, mergeRequests: async () => rawMr && rawMr.state === 'opened' ? [{ ...rawMr, sourceBranch: rawMr.source_branch, targetBranch: rawMr.target_branch, webUrl: rawMr.web_url }] : [], request: async (_c, url, options) => {
    assert.ok(url.startsWith('/projects/123/merge_requests'))
    if (options?.method === 'POST') { posts++; const b = options.body; rawMr = { id: 99, iid: 7, project_id: 123, title: b.title, description: b.description, source_branch: b.source_branch, target_branch: b.target_branch, sha: branchSha, state: 'opened', draft: true, web_url: 'https://git.example/group/repo/-/merge_requests/7' }; return structuredClone(rawMr) }
    assert.equal(url, '/projects/123/merge_requests/7'); exactGets++; return structuredClone(rawMr)
  } }
  const safeGit = { ...git, git: async (cwd, args, options) => { if (args[0] !== 'push') return git.git(cwd, args, options); pushes++; assert.ok(!args.some(a => a.includes('force'))); assert.equal(options.push, true); branchSha = args.at(-1).split(':')[0]; if (rawMr) rawMr.sha = branchSha; if (failPush) throw Error('unknown push'); return '' } }
  const service = new GitLabWorkspace(ctx, { api, git: safeGit }); await service.ready()
  await service.put('connections', connection); await service.put('checkouts', { id: 'checkout', connectionId: 'c', projectId: '123', path: root, defaultBranch: 'main', project, remote, createdAt: connection.createdAt }); await service.put('environments', env)
  const commit = async (body = 'changed\n') => { await writeFile(path.join(worktreePath, 'file.txt'), body); await git.git(worktreePath, ['add', '.']); await git.git(worktreePath, ['commit', '--allow-empty', '-m', 'iteration']); return git.commit(worktreePath, 'HEAD') }
  const preview = (revision = 1, overrides = {}) => service.prepareDelivery({ environmentId: env.id, taskId: env.taskId, resultRevision: revision, title: 'Original', description: 'Frozen body', ...overrides })
  const deliver = async () => { await commit(); const d = await preview(); await service.pushDelivery({ deliveryId: d.id, confirm: true }); return service.publishDraft({ deliveryId: d.id, confirm: true }) }
  return { service, env, api, safeGit, ctx, commit, preview, deliver, counts: () => ({ pushes, posts, exactGets }), setCwd: v => { cwd = v }, mutateMr: fn => fn(rawMr), setRemote: sha => { branchSha = sha }, unknownPush: () => { failPush = true } }
}

test('inspection is fresh, scoped to exact session, bounded and never agent-callable', async t => {
  const f = await fixture(t); await f.commit()
  const result = await f.service.inspectEnvironment({ environmentId: 'env', path: '/not-used' })
  assert.equal(result.clean, true); assert.equal(result.branch, f.env.branch); assert.match(result.headSha, /^[a-f0-9]{40}$/)
  assert.deepEqual(result.files, [{ path: 'file.txt', status: 'M' }]); assert.match(result.diff, /\+changed/); assert.equal(result.diffTruncated, false); assert.ok(result.observedAt)
  await writeFile(path.join(f.env.worktreePath, 'new.txt'), 'dirty')
  assert.equal((await f.service.inspectEnvironment({ environmentId: 'env' })).clean, false)
  assert.equal((await dispatch(f.service, { action: 'inspectEnvironment', environmentId: 'env' }, 'agent')).error.code, 'USER_ONLY')
  f.setCwd('/wrong'); await assert.rejects(f.service.inspectEnvironment({ environmentId: 'env' }), { code: 'CWD_MISMATCH' })
})

test('large local diff truncates successfully and disables external diff execution', async t => {
  const f = await fixture(t); await f.commit(Array.from({ length: 10000 }, (_, i) => `bounded-${i}`).join('\n'))
  await git.git(f.env.worktreePath, ['config', 'diff.external', '/never-execute-this'])
  const result = await f.service.inspectEnvironment({ environmentId: 'env' }); assert.equal(result.diffTruncated, true); assert.ok(result.diff.length <= 65536)
})

test('continuation freezes original MR, pushes non-force FF, and never creates or edits an MR', async t => {
  const f = await fixture(t), first = await f.deliver(); await f.commit('second\n')
  // Old preview can be stale without erasing verified history or blocking iteration.
  await assert.rejects(f.service.verifyDelivery({ deliveryId: first.id }), { code: 'HEAD_CHANGED' })
  assert.equal((await f.service.getDelivery(first.id)).state, 'unknown')
  const d = await f.preview(2); assert.equal(d.priorDeliveryId, first.id); assert.equal(d.priorHeadSha, first.headSha); assert.equal(d.priorMR.iid, 7); assert.equal(d.marker, first.marker); assert.ok(d.raceLimits.length)
  assert.equal((await f.service.pushDelivery({ deliveryId: d.id, confirm: true })).state, 'pushed')
  const next = await f.service.publishDraft({ deliveryId: d.id, confirm: true }); assert.equal(next.state, 'verified'); assert.equal(next.mr.iid, 7); assert.equal(next.mr.title, first.mr.title)
  assert.deepEqual({ pushes: f.counts().pushes, posts: f.counts().posts }, { pushes: 2, posts: 1 })
  await f.commit('third\n'); const third = await f.preview(3); assert.equal(third.priorDeliveryId, next.id); assert.equal(third.priorHeadSha, next.headSha)
})

for (const state of ['closed', 'merged']) test(`continuation GETs exact ${state} original MR and refuses writes`, async t => {
  const f = await fixture(t); await f.deliver(); await f.commit('next\n'); f.mutateMr(m => { m.state = state }); f.setRemote(null)
  const before = f.counts().exactGets
  await assert.rejects(f.preview(2), { code: 'CONTINUATION_MISMATCH' }); assert.equal(f.counts().exactGets, before + 1); assert.equal(f.counts().posts, 1); assert.equal(f.counts().pushes, 1)
})

test('continuation auto-freezes edited defaults but rejects unrelated MR and foreign remote head', async t => {
  const f = await fixture(t), first = await f.deliver(); await f.commit('next\n')
  for (const edits of [{ title: 'Different' }, { description: 'New execution result summary' }]) { const d = await f.preview(2, edits); assert.equal(d.title, first.title); assert.equal(d.description, first.description); assert.equal(d.state, 'prepared') }
  f.mutateMr(m => { m.description = 'unrelated' }); await assert.rejects(f.preview(3), { code: 'CONTINUATION_MISMATCH' })
  f.mutateMr(m => { m.description = first.mr.description }); f.setRemote('f'.repeat(40)); await assert.rejects(f.preview(3), { code: 'REMOTE_HEAD_CHANGED' })
})

test('remote and MR races are rechecked immediately before continuation push', async t => {
  const f = await fixture(t), first = await f.deliver(); await f.commit('next\n'); const d = await f.preview(2)
  f.setRemote('f'.repeat(40)); await assert.rejects(f.service.pushDelivery({ deliveryId: d.id, confirm: true }), { code: 'REMOTE_HEAD_CHANGED' })
  f.setRemote(first.headSha); f.mutateMr(m => { m.state = 'merged' }); await assert.rejects(f.service.pushDelivery({ deliveryId: d.id, confirm: true }), { code: 'CONTINUATION_MISMATCH' }); assert.equal(f.counts().pushes, 1)
})

test('unknown continuation push cannot repeat but reconciles exact MR read-only', async t => {
  const f = await fixture(t); await f.deliver(); await f.commit('next\n'); const d = await f.preview(2); f.unknownPush()
  await assert.rejects(f.service.pushDelivery({ deliveryId: d.id, confirm: true }))
  await assert.rejects(f.service.pushDelivery({ deliveryId: d.id, confirm: true }), { code: 'DELIVERY_UNKNOWN' })
  await assert.rejects(f.preview(3), { code: 'DELIVERY_UNKNOWN' })
  const resumed = new GitLabWorkspace(f.ctx, { api: f.api, git: f.safeGit })
  assert.equal((await resumed.verifyDelivery({ deliveryId: d.id })).state, 'verified'); assert.equal(f.counts().pushes, 2); assert.equal(f.counts().posts, 1)
})

test('MR closes after continuation push: no POST, verification remains unknown', async t => {
  const f = await fixture(t); await f.deliver(); await f.commit('next\n'); const d = await f.preview(2)
  await f.service.pushDelivery({ deliveryId: d.id, confirm: true }); f.mutateMr(m => { m.state = 'closed' })
  await assert.rejects(f.service.publishDraft({ deliveryId: d.id, confirm: true }), { code: 'CONTINUATION_MISMATCH' })
  assert.equal((await f.service.verifyDelivery({ deliveryId: d.id })).state, 'unknown'); assert.equal(f.counts().posts, 1)
})

test('strict delivery schema refuses incomplete continuation binding', () => {
  assert.equal(schemas.deliveries.safeParse({ priorHeadSha: 'a'.repeat(40) }).success, false)
})

function apiFixture(respond) {
  const seen = [], c = { id: 'c', baseUrl: 'https://git.example', identity: { id: 42 } }
  const api = new GitLabApi({ credentials: { readRecord: async () => ({ kind: 'api-key', key: 'fake-secret' }) }, fetch: async (url, init) => { assert.equal(init.method, 'GET'); seen.push(url); return respond(new URL(url).pathname.replace('/api/v4', ''), new URL(url).searchParams) } })
  return { api, c, seen }
}
const rawMr = { id: 99, iid: 7, project_id: 123, title: 'Draft: Review', description: 'Body', source_branch: 'source', target_branch: 'main', sha: 'a'.repeat(40), state: 'merged', draft: true, web_url: 'https://git.example/group/repo/-/merge_requests/7' }

test('remote review reads exact merged MR; missing permissions never become passing checks', async () => {
  const f = apiFixture(p => p.endsWith('/7') ? Response.json(rawMr) : p.endsWith('/pipelines') ? Response.json([]) : p === '/projects/123' ? Response.json({ jobs_enabled: true }) : new Response('', { status: 403 }))
  const result = await f.api.readReview(f.c, '123', 7)
  assert.equal(result.mr.data.state, 'merged'); assert.equal(result.mr.data.sha, rawMr.sha); assert.equal(result.pipeline.data.state, 'unknown')
  for (const key of ['notes', 'discussions', 'approvals']) assert.deepEqual(result[key], { status: 'unavailable', reason: 'HTTP_403' })
  assert.ok(result.observedAt); assert.ok(!JSON.stringify(result).includes('fake-secret'))
})

test('pipeline explicitly disabled differs from unknown, real status and unavailable', async () => {
  for (const [mode, expected] of [['disabled', 'not_configured'], ['running', 'running'], ['denied', 'unavailable']]) {
    const f = apiFixture(p => p.endsWith('/7') ? Response.json(rawMr) : p.endsWith('/pipelines') ? mode === 'denied' ? new Response('', { status: 403 }) : Response.json(mode === 'running' ? [{ id: 1, status: 'running', sha: rawMr.sha }] : []) : p === '/projects/123' ? Response.json({ jobs_enabled: false }) : p.endsWith('/approvals') ? Response.json({}) : Response.json([]))
    const r = await f.api.readReview(f.c, 123, 7); assert.equal(mode === 'denied' ? r.pipeline.status : r.pipeline.data.state, expected); assert.equal(r.approvals.data.approved, null)
  }
})

test('review discussion/note pages are bounded and expose truncation', async () => {
  const f = apiFixture(p => p.endsWith('/7') ? Response.json(rawMr) : p.endsWith('/discussions') ? Response.json([{ id: 'd', notes: Array.from({ length: 31 }, (_, id) => ({ id, body: 'x'.repeat(4100), resolved: false })) }]) : p.endsWith('/notes') ? Response.json(Array.from({ length: 30 }, (_, id) => ({ id, body: 'note' }))) : p.endsWith('/approvals') ? Response.json({ approved: false, approvals_left: 1 }) : Response.json([]))
  const r = await f.api.readReview(f.c, 123, 7); assert.equal(r.discussions.data.items[0].notes.length, 30); assert.equal(r.discussions.data.items[0].notesTruncated, true); assert.equal(r.discussions.data.items[0].notes[0].body.length, 4000); assert.equal(r.notes.data.hasMore, true); assert.equal(r.approvals.data.approved, false)
})

test('review requests across repositories use authenticated reviewer_id and include projectId', async () => {
  const f = apiFixture((p, q) => { if (p === '/user') return Response.json({ id: 42 }); assert.equal(p, '/merge_requests'); assert.equal(q.get('reviewer_id'), '42'); assert.equal(q.get('scope'), 'all'); assert.equal(q.get('page'), '2'); return Response.json([rawMr, { ...rawMr, project_id: 456 }]) })
  const rows = await f.api.reviewRequests(f.c, 2); assert.deepEqual(rows.map(r => r.projectId), ['123', '456'])
  for (const action of ['review', 'reviewRequests']) { assert.ok(!toolParameters.properties.action.enum.includes(action)); assert.equal((await dispatch({}, { action }, 'agent')).error.code, 'USER_ONLY') }
})
