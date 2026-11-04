import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'

const source = await readFile(new URL('../client.js', import.meta.url), 'utf8')
const deferred = () => {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

// Public seams: the registered panel + navigation service, DOM event props and
// Host request bodies. This executes the real factory, not a preview application.
// Components expand recursively with independent, keyed hook owners. Conditional
// children really unmount (including their effect cleanups), just as in React.
function harness(initial = {}) {
  let plugin, current, dirty = false, root, tree
  let owners = new Map()
  const services = new Map(), registrations = [], disposers = [], requests = [], panels = []
  const listeners = new Map(), responders = new Map(), functionIds = new WeakMap()
  let nextFunctionId = 0, effectDepth = 0
  const data = {
    status: { connections: [], checkouts: [] }, taskList: { items: [] },
    projects: { items: [] }, branches: { items: [] }, ...initial,
  }
  const clean = owner => {
    owner.live = false
    for (const effect of owner.effects) effect?.cleanup?.()
  }
  const React = {
    Fragment: 'fragment',
    createElement(type, props, ...children) {
      children = children.flat(Infinity)
      return { type, props: { ...props, children }, children }
    },
    useState(initialValue) {
      const owner = current, index = owner.cursor++
      if (!(index in owner.values)) owner.values[index] = typeof initialValue === 'function' ? initialValue() : initialValue
      return [owner.values[index], value => {
        if (!owner.live) return
        const next = typeof value === 'function' ? value(owner.values[index]) : value
        if (!Object.is(next, owner.values[index])) { owner.values[index] = next; dirty = true }
      }]
    },
    useRef(initialValue) {
      const owner = current, index = owner.cursor++
      return owner.values[index] ||= { current: initialValue }
    },
    useCallback(callback) { return callback },
    useEffect(callback, deps) {
      const owner = current, index = owner.cursor++, old = owner.effects[index]
      if (!old || !deps || deps.length !== old.deps?.length || deps.some((value, i) => !Object.is(value, old.deps[i]))) {
        owner.pending.push(() => {
          old?.cleanup?.()
          effectDepth++
          try { owner.effects[index] = { deps, cleanup: callback() } } finally { effectDepth-- }
        })
      }
    },
  }
  const context = {
    window: {
      __ModuleLoader__: { load(module) { plugin = module.factory(name => { assert.equal(name, 'react'); return React }) } },
      addEventListener(name, callback) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(callback) },
      removeEventListener(name, callback) { listeners.get(name)?.delete(callback) },
    },
    document: { visibilityState: 'visible', activeElement: null, addEventListener() {}, removeEventListener() {} },
    AbortController, URL, queueMicrotask,
    fetch(url, options) {
      const body = JSON.parse(options.body)
      const request = { ...body, endpoint: url, signal: options.signal }
      requests.push(request)
      let value
      try {
        value = responders.has(body.action) ? responders.get(body.action)(request) : data[body.action]
        assert.notEqual(value, undefined, `Unexpected mocked request: ${url} ${body.action}`)
      } catch (error) { return Promise.reject(error) }
      // Deliberately don't automatically reject aborted requests: late replies
      // must be isolated by the actual client's signal/operation guards.
      return Promise.resolve(value).then(value => ({ ok: true, json: async () => ({ ok: true, data: value }) }))
    },
    setInterval: () => 1, clearInterval() {},
  }
  vm.runInNewContext(source, context, { filename: 'gitlab-panel/client.js' })
  const ctx = {
    get: name => services.get(name),
    provide(name, value) {
      assert.ok(effectDepth > 0, `${name} must be owned by ctx.effect`)
      services.set(name, value)
      return () => { if (services.get(name) === value) services.delete(name) }
    },
    effect(callback) {
      effectDepth++
      try { const cleanup = callback(); if (cleanup) disposers.push(cleanup) } finally { effectDepth-- }
    },
    locale: { bind: () => key => key, register: () => () => {} },
    slots: {
      inject: (_name, callback) => callback(),
      register(options, component) { registrations.push({ options, component }); return () => {} },
    },
  }
  services.set('layout', { selectPanel: value => panels.push(value) })
  plugin.apply(ctx)
  const panel = registrations.find(row => row.options.key === 'gitlab').component
  const expand = (element, path, seen, effects) => {
    if (!element || typeof element !== 'object') return element
    if (typeof element.type === 'function') {
      if (!functionIds.has(element.type)) functionIds.set(element.type, ++nextFunctionId)
      const id = `${path}/fn:${functionIds.get(element.type)}:key:${element.props.key ?? ''}`
      let owner = owners.get(id)
      if (!owner) { owner = { values: [], effects: [], pending: [], cursor: 0, live: true }; owners.set(id, owner) }
      seen.add(id)
      current = owner; owner.cursor = 0
      const child = element.type(element.props)
      effects.push(...owner.pending.splice(0))
      return { ...element, children: [expand(child, `${id}/output`, seen, effects)] }
    }
    return { ...element, children: element.children.map((child, i) => expand(child, `${path}/${child?.props?.key != null ? `key:${child.props.key}` : i}`, seen, effects)) }
  }
  const render = () => {
    if (!root) root = { type: panel, props: {}, children: [] }
    let turns = 0
    do {
      assert.ok(++turns < 40, 'hook harness did not settle')
      dirty = false
      const seen = new Set(), effects = []
      tree = expand(root, 'root', seen, effects)
      for (const [id, owner] of owners) if (!seen.has(id)) { clean(owner); owners.delete(id) }
      for (const effect of effects) effect()
    } while (dirty)
    return tree
  }
  const unmount = () => { for (const owner of owners.values()) clean(owner); owners = new Map(); root = null; tree = null }
  const app = {
    services, panels, requests, listeners, data,
    get tree() { return render() },
    render, unmount,
    respond(action, callback) { responders.set(action, callback) },
    calls(action) { return requests.filter(row => row.action === action) },
    async settle() {
      // No timers, sockets, servers or actual network. Pump resolved fetch/json
      // promises together with normal React rerenders/effect commits.
      for (let i = 0; i < 12; i++) { await Promise.resolve(); render() }
      return tree
    },
    dispose() { unmount(); for (const cleanup of disposers.reverse()) cleanup() },
  }
  return app
}
function nodes(tree, predicate) {
  if (!tree || typeof tree !== 'object') return []
  return [...(predicate(tree) ? [tree] : []), ...(tree.children || []).flatMap(child => nodes(child, predicate))]
}
const text = tree => !tree || typeof tree !== 'object' ? String(tree ?? '') : (tree.children || []).map(text).join(' ')
const component = (app, name) => nodes(app.tree, node => node.type?.name === name)[0]
function button(app, key) {
  const node = nodes(app.tree, node => node.type === 'button' && text(node).trim() === key)[0]
  assert.ok(node, `Missing button identity: ${key}`)
  return node
}
function click(app, key) {
  const node = button(app, key)
  assert.ok(!node.props.disabled, `Button disabled: ${key}`)
  const value = node.props.onClick?.()
  app.render()
  return value
}
function input(app, name, value) {
  const node = nodes(app.tree, node => ['input', 'textarea', 'select'].includes(node.type) && node.props.name === name)[0]
  assert.ok(node, `Missing field: ${name}`)
  node.props.onChange({ target: { value, checked: value } })
  app.render()
}
function submit(app) {
  const form = nodes(app.tree, node => node.type === 'form' && node.props.noValidate)[0]
  assert.ok(form, 'Wizard form is mounted')
  form.props.onSubmit({ preventDefault() {} })
  app.render()
}
function step(app) { return text(nodes(app.tree, node => node.type === 'li' && node.props['aria-current'] === 'step')[0]).trim() }
const checkout = { id: 'checkout-a', connectionId: 'gitlab-a', projectId: '42', path: '/repos/application', defaultBranch: 'main', project: { pathWithNamespace: 'team/application' } }
const status = { connections: [{ id: 'gitlab-a', name: 'Company', baseUrl: 'https://gitlab.example' }], checkouts: [checkout] }
const plan = { id: 'plan-1', plan: { sourceRoot: '/repos/application', baseRef: 'main', baseCommit: 'abc123', project: { pathWithNamespace: 'team/application' } } }
function taskFixture(overrides = {}) {
  return {
    id: 'task-a', source: { kind: 'technical' }, objective: 'Repair tests', acceptanceCriteria: 'Unit tests pass',
    status: 'result_submitted', version: 5, updatedAt: '2026-11-04T07:00:00Z',
    result: { revision: 2, outcome: 'succeeded', summary: 'Repaired tests', tests: ['node --test: passed'] },
    code: { target: { provider: 'gitlab', connectionId: 'gitlab-a', projectId: '42', targetBranch: 'main' }, environment: { id: 'environment-a', sessionId: 'session-a', executionCwd: '/worktrees/a' } },
    ...overrides,
  }
}
async function openTask(app, id = 'task-a') {
  app.services.get('gitlabNavigation').openTask(id)
  await app.settle()
  assert.equal(component(app, 'TaskSpace').props.id, id)
}
async function wizardAtConfirm(app, seed) {
  app.services.get('gitlabNavigation').startWork(seed)
  await app.settle()
  assert.equal(step(app), 'goalStep')
  input(app, 'objective', 'Repair tests')
  input(app, 'criteria', 'Unit tests pass')
  input(app, 'allowFiles', true)
  input(app, 'allowCommands', true)
  input(app, 'notes', 'Do not change credentials')
  submit(app)
  assert.equal(step(app), 'locationStep')
  input(app, 'checkoutId', 'checkout-a')
  input(app, 'subdirectory', 'packages/core')
  submit(app)
  assert.equal(step(app), 'confirmStep')
}

test('gitlabNavigation is effect-owned, frozen, available before mount and disposed with its plugin', async t => {
  const app = harness({ status, taskGet: taskFixture() }); t.after(() => app.dispose())
  const nav = app.services.get('gitlabNavigation')
  assert.deepEqual(Object.keys(nav).sort(), ['openRepository', 'openTask', 'startWork'])
  assert.equal(Object.isFrozen(nav), true)
  assert.throws(() => nav.openTask(''), /Invalid task/)
  nav.openTask('task-a')
  assert.deepEqual(app.panels, ['gitlab'])
  await app.settle()
  assert.equal(component(app, 'TaskSpace').props.id, 'task-a')
  assert.equal(app.calls('taskGet')[0].endpoint, '/api/meegle-panel')
  app.unmount()
  nav.openTask('task-after-unmount')
  app.data.taskGet = taskFixture({ id: 'task-after-unmount' })
  await app.settle()
  assert.equal(component(app, 'TaskSpace').props.id, 'task-after-unmount')
  app.dispose()
  assert.equal(app.services.has('gitlabNavigation'), false)
})

test('mounted navigation activates work and repository routes; unmounted repository selection is retained', async t => {
  const app = harness({ status, taskGet: taskFixture() }); t.after(() => app.dispose())
  await app.settle()
  click(app, 'settings')
  assert.equal(button(app, 'settings').props['aria-current'], 'page')
  await openTask(app)
  assert.equal(button(app, 'mywork').props['aria-current'], 'page')
  const nav = app.services.get('gitlabNavigation')
  nav.openRepository({ connectionId: 'gitlab-a', projectId: '42' })
  await app.settle()
  assert.equal(button(app, 'repositories').props['aria-current'], 'page')
  assert.equal(app.calls('branches').at(-1).projectId, '42')
  app.unmount()
  nav.openRepository({ connectionId: 'gitlab-a', projectId: '77' })
  await app.settle()
  assert.equal(app.calls('branches').at(-1).projectId, '77')
})

test('technical wizard validates goal/location stages and creates a source-discriminated task with the exact code target', async t => {
  const app = harness({ status }); t.after(() => app.dispose())
  const created = taskFixture({ status: 'created', version: 1, result: undefined })
  const prepared = { ...created, version: 2, code: { ...created.code, plan } }
  app.respond('taskCreate', () => created)
  app.respond('taskPrepareDispatch', () => prepared)
  app.respond('taskDispatch', () => ({ ...prepared, version: 3, status: 'dispatched' }))
  app.respond('taskGet', () => ({ ...prepared, version: 3, status: 'dispatched' }))
  app.services.get('gitlabNavigation').startWork()
  await app.settle()
  submit(app)
  assert.equal(step(app), 'goalStep')
  assert.deepEqual(nodes(app.tree, node => node.props['aria-invalid'] === true).map(node => node.props.name).sort(), ['criteria', 'objective'])
  input(app, 'objective', 'Repair tests'); input(app, 'criteria', 'Unit tests pass'); submit(app)
  assert.equal(step(app), 'locationStep')
  submit(app)
  assert.equal(step(app), 'locationStep')
  assert.equal(app.calls('taskCreate').length, 0)
  input(app, 'checkoutId', 'checkout-a'); input(app, 'subdirectory', 'packages/core'); submit(app)
  assert.equal(step(app), 'confirmStep')
  assert.equal(app.calls('taskCreate').length, 0, 'review stage itself is not authorization to create')
  await click(app, 'savePlan'); await app.settle()
  const request = app.calls('taskCreate')[0]
  assert.deepEqual(request.source, { kind: 'technical' })
  assert.equal(request.workMode, 'change', 'ordinary technical work defaults to code-change mode')
  for (const fakeIdentity of ['connectionId', 'projectKey', 'workItemId', 'workItem']) assert.equal(Object.hasOwn(request, fakeIdentity), false, fakeIdentity)
  assert.deepEqual(request.codeTarget, { provider: 'gitlab', connectionId: 'gitlab-a', projectId: '42', checkoutId: 'checkout-a', subdirectory: 'packages/core', targetBranch: 'main', executionMode: 'new-worktree', deliveryPolicy: 'draft-mr-manual' })
  assert.equal(request.endpoint, '/api/meegle-panel')
  assert.equal(app.calls('taskPrepareDispatch')[0].expectedVersion, 1)
  assert.equal(app.calls('taskDispatch').length, 0)
  await click(app, 'startConfirmed'); await app.settle()
  const dispatched = app.calls('taskDispatch')[0]
  assert.equal(dispatched.taskId, 'task-a'); assert.equal(dispatched.expectedVersion, 2)
  assert.equal(dispatched.planId, 'plan-1'); assert.equal(dispatched.confirm, true)
  assert.equal(component(app, 'TaskSpace').props.id, 'task-a')
})

test('Meegle-started wizard preserves the genuine business identity separately from GitLab codeTarget', async t => {
  const app = harness({ status }); t.after(() => app.dispose())
  app.respond('taskCreate', () => taskFixture({ version: 1 }))
  app.respond('taskPrepareDispatch', () => taskFixture({ version: 2, code: { plan } }))
  await wizardAtConfirm(app, { connectionId: 'meegle-source', projectKey: 'space-real', id: 123, workItem: { title: 'Original business item' } })
  await click(app, 'savePlan'); await app.settle()
  const request = app.calls('taskCreate')[0]
  assert.equal(request.connectionId, 'meegle-source'); assert.equal(request.projectKey, 'space-real'); assert.equal(request.workItemId, '123')
  assert.deepEqual(request.workItem, { title: 'Original business item' })
  assert.equal(request.codeTarget.connectionId, 'gitlab-a')
  assert.notEqual(request.source?.kind, 'technical')
})

test('saved task and frozen plan survive settings navigation without duplicate taskCreate', async t => {
  const app = harness({ status }); t.after(() => app.dispose())
  const created = taskFixture({ version: 1, status: 'created' })
  const prepared = { ...created, version: 2, code: { ...created.code, plan } }
  app.respond('taskCreate', () => created); app.respond('taskPrepareDispatch', () => prepared)
  await wizardAtConfirm(app)
  await click(app, 'savePlan'); await app.settle()
  assert.ok(button(app, 'startConfirmed'))
  click(app, 'settings')
  assert.equal(component(app, 'StartWizard'), undefined, 'settings really unmounts wizard')
  assert.equal(app.listeners.get('beforeunload')?.size || 0, 1, 'reload protection is owned by the plugin, not the wizard')
  let prevented = false
  for (const handler of app.listeners.get('beforeunload') || []) handler({ preventDefault() { prevented = true } })
  assert.equal(prevented, false, 'a durably saved task does not need an unsaved-draft warning')
  click(app, 'mywork'); await app.settle()
  assert.equal(step(app), 'confirmStep')
  assert.ok(button(app, 'startConfirmed'))
  assert.ok(text(app.tree).includes('abc123'), 'restored exact pinned SHA remains visible')
  assert.equal(app.calls('taskCreate').length, 1)
  assert.equal(app.calls('taskPrepareDispatch').length, 1)
})

test('a create reply received after settings navigation is retained without preparing or creating twice', async t => {
  const creation = deferred(), app = harness({ status }); t.after(() => app.dispose())
  const created = taskFixture({ status: 'created', version: 1 })
  const prepared = { ...created, version: 2, code: { ...created.code, plan } }
  app.respond('taskCreate', () => creation.promise)
  app.respond('taskPrepareDispatch', () => prepared)
  await wizardAtConfirm(app)
  const saving = click(app, 'savePlan')
  assert.equal(app.calls('taskCreate').length, 1)
  click(app, 'settings')
  creation.resolve(created); await saving; await app.settle()
  assert.equal(app.calls('taskPrepareDispatch').length, 0, 'unmounted wizard must not advance a side-effect chain')
  click(app, 'mywork'); await app.settle()
  assert.equal(step(app), 'confirmStep')
  await click(app, 'savePlan'); await app.settle()
  assert.equal(app.calls('taskCreate').length, 1, 'created task was saved even though its wizard had unmounted')
  assert.equal(app.calls('taskPrepareDispatch').length, 1)
  assert.ok(button(app, 'startConfirmed'))
})

test('a prepared plan reply received while settings is open survives remount with its new version', async t => {
  const preparation = deferred(), app = harness({ status }); t.after(() => app.dispose())
  const created = taskFixture({ status: 'created', version: 1 })
  const prepared = { ...created, version: 2, code: { ...created.code, plan } }
  app.respond('taskCreate', () => created)
  app.respond('taskPrepareDispatch', () => preparation.promise)
  await wizardAtConfirm(app)
  const saving = click(app, 'savePlan')
  await app.settle()
  assert.equal(app.calls('taskPrepareDispatch').length, 1)
  click(app, 'settings')
  preparation.resolve(prepared); await saving; await app.settle()
  click(app, 'mywork'); await app.settle()
  assert.equal(step(app), 'confirmStep')
  assert.ok(button(app, 'startConfirmed'), 'late plan must be retained instead of retrying with obsolete created-task version')
  assert.equal(app.calls('taskCreate').length, 1)
  assert.equal(app.calls('taskPrepareDispatch').length, 1)
})

test('push and Draft MR require distinct frozen confirmations with task version, result revision and delivery id', async t => {
  const original = taskFixture(), app = harness({ status, taskGet: original }); t.after(() => app.dispose())
  const delivery = { id: 'delivery-1', state: 'prepared', headSha: 'head-aaa', sourceBranch: 'work/task-a', targetBranch: 'main', title: 'Repair tests', description: 'Repaired tests' }
  const prepared = { ...original, version: 6, code: { ...original.code, delivery } }
  const pushed = { ...prepared, version: 7, code: { ...prepared.code, delivery: { ...delivery, state: 'pushed' } } }
  const published = { ...pushed, version: 8, code: { ...pushed.code, delivery: { ...delivery, state: 'verified', mr: { iid: 15 } } } }
  app.respond('taskPrepareDelivery', () => { app.data.taskGet = prepared; return prepared })
  app.respond('taskPushDelivery', () => { app.data.taskGet = pushed; return pushed })
  app.respond('taskPublishDraft', () => { app.data.taskGet = published; return published })
  app.respond('review', () => ({ observedAt: '2026-11-04T07:00:00Z' }))
  await openTask(app)
  click(app, 'changes')
  input(app, 'mrTitle', 'Exact MR title'); input(app, 'mrBody', 'Exact MR description')
  await click(app, 'preparePreview'); await app.settle()
  const preview = app.calls('taskPrepareDelivery')[0]
  assert.equal(preview.expectedVersion, 5); assert.equal(preview.resultRevision, 2)
  assert.equal(preview.title, 'Exact MR title'); assert.equal(preview.description, 'Exact MR description')
  assert.equal(app.calls('taskPushDelivery').length, 0)
  assert.equal(app.calls('taskPublishDraft').length, 0)
  assert.ok(nodes(app.tree, node => node.props.className === 'glp-confirm').length)
  await click(app, 'confirm'); await app.settle()
  const push = app.calls('taskPushDelivery')[0]
  assert.deepEqual({ taskId: push.taskId, expectedVersion: push.expectedVersion, resultRevision: push.resultRevision, deliveryId: push.deliveryId, confirm: push.confirm }, { taskId: 'task-a', expectedVersion: 6, resultRevision: 2, deliveryId: 'delivery-1', confirm: true })
  assert.equal(app.calls('taskPublishDraft').length, 0, 'push does not authorize publishing an MR')
  assert.equal(nodes(app.tree, node => node.props.className === 'glp-confirm').length, 0)
  click(app, 'approveMR')
  assert.equal(app.calls('taskPublishDraft').length, 0, 'opening second confirmation is not a write')
  await click(app, 'confirm'); await app.settle()
  const mr = app.calls('taskPublishDraft')[0]
  assert.deepEqual({ taskId: mr.taskId, expectedVersion: mr.expectedVersion, resultRevision: mr.resultRevision, deliveryId: mr.deliveryId, confirm: mr.confirm }, { taskId: 'task-a', expectedVersion: 7, resultRevision: 2, deliveryId: 'delivery-1', confirm: true })
})

test('late task reads and mutation replies cannot overwrite a newer task route', async t => {
  const a = deferred(), prepare = deferred()
  const taskB = taskFixture({ id: 'task-b', objective: 'Current task B' })
  const app = harness({ status }); t.after(() => app.dispose())
  app.respond('taskGet', request => request.taskId === 'task-a' ? a.promise : taskB)
  app.services.get('gitlabNavigation').openTask('task-a'); app.render()
  const oldRead = app.calls('taskGet').at(-1)
  await openTask(app, 'task-b')
  assert.equal(oldRead.signal.aborted, true)
  a.resolve(taskFixture({ objective: 'Stale task A' })); await app.settle()
  assert.ok(text(app.tree).includes('Current task B'))
  assert.equal(text(app.tree).includes('Stale task A'), false)
  app.respond('taskPrepareDelivery', () => prepare.promise)
  click(app, 'changes'); click(app, 'preparePreview')
  await openTask(app, 'task-c')
  prepare.resolve(taskFixture({ id: 'task-b', objective: 'Stale mutation B', version: 6, code: { delivery: { id: 'old-delivery', state: 'prepared' } } }))
  await app.settle()
  assert.equal(component(app, 'TaskSpace').props.id, 'task-c')
  assert.equal(text(app.tree).includes('Stale mutation B'), false)
  assert.equal(nodes(app.tree, node => node.props.className === 'glp-confirm').length, 0)
})

for (const [changed, update] of [
  ['task version', task => ({ ...task, version: task.version + 1 })],
  ['result revision', task => ({ ...task, result: { ...task.result, revision: 3 } })],
  ['delivery identity', task => ({ ...task, code: { ...task.code, delivery: { ...task.code.delivery, id: 'delivery-new' } } })],
]) {
  test(`a changed ${changed} invalidates the frozen publication confirmation`, async t => {
    const original = taskFixture()
    const prepared = { ...original, code: { ...original.code, delivery: { id: 'delivery-1', state: 'prepared', headSha: 'head-a', sourceBranch: 'work/a', targetBranch: 'main' } } }
    const app = harness({ status, taskGet: prepared }); t.after(() => app.dispose())
    await openTask(app)
    click(app, 'changes'); click(app, 'approvePush')
    assert.equal(button(app, 'confirm').props.disabled, false)
    app.data.taskGet = update(prepared)
    click(app, 'refresh'); await app.settle()
    assert.equal(button(app, 'confirm').props.disabled, true)
    assert.ok(nodes(app.tree, node => node.props.role === 'alert' && text(node).includes('stalePreview')).length)
    // Even a retained event handler must recheck the frozen tuple before acting.
    button(app, 'confirm').props.onClick(); await app.settle()
    assert.equal(app.calls('taskPushDelivery').length, 0)
    assert.equal(app.calls('taskPublishDraft').length, 0)
  })
}

test('replacing an existing draft explicitly adopts the new external handoff source', async t => {
  const app = harness({ status }); t.after(() => app.dispose())
  const nav = app.services.get('gitlabNavigation')
  nav.startWork({ connectionId: 'business-a', projectKey: 'space-a', id: '11', title: 'First item' })
  await app.settle()
  assert.equal(nodes(app.tree, node => node.props.name === 'objective')[0].props.value, 'First item')
  nav.startWork({ connectionId: 'business-b', projectKey: 'space-b', id: '22', title: 'Second item' })
  await app.settle()
  assert.equal(component(app, 'StartWizard'), undefined, 'handoff does not silently discard existing work')
  assert.ok(button(app, 'resumeDraft'))
  click(app, 'replaceDraft'); await app.settle()
  assert.equal(nodes(app.tree, node => node.props.name === 'objective')[0].props.value, 'Second item')
  input(app, 'criteria', 'Second verification'); submit(app)
  input(app, 'checkoutId', 'checkout-a'); submit(app)
  app.respond('taskCreate', () => taskFixture({ id: 'second-task', version: 1 }))
  app.respond('taskPrepareDispatch', () => taskFixture({ id: 'second-task', version: 2, code: { plan } }))
  await click(app, 'savePlan'); await app.settle()
  const request = app.calls('taskCreate')[0]
  assert.equal(request.connectionId, 'business-b')
  assert.equal(request.projectKey, 'space-b')
  assert.equal(request.workItemId, '22')
})

test('analysis mode clears and disables file changes and is preserved in the taskCreate request', async t => {
  const app = harness({ status }); t.after(() => app.dispose())
  app.respond('taskCreate', () => taskFixture({ workMode: 'analysis', version: 1, status: 'created' }))
  app.respond('taskPrepareDispatch', () => taskFixture({ workMode: 'analysis', version: 2, code: { plan } }))
  app.services.get('gitlabNavigation').startWork(); await app.settle()
  const field = name => nodes(app.tree, node => node.props.name === name)[0]
  assert.equal(field('workMode').props.value, 'change')
  assert.deepEqual(nodes(field('workMode'), node => node.type === 'option').map(node => node.props.value), ['change', 'analysis'])
  input(app, 'allowFiles', true)
  assert.equal(field('allowFiles').props.checked, true)
  input(app, 'workMode', 'analysis')
  assert.equal(field('allowFiles').props.checked, false)
  assert.equal(field('allowFiles').props.disabled, true)
  input(app, 'workMode', 'change')
  assert.equal(field('allowFiles').props.disabled, false)
  assert.equal(field('allowFiles').props.checked, false, 'returning to change mode does not silently restore file permission')
  input(app, 'workMode', 'analysis')
  input(app, 'allowCommands', true)
  input(app, 'objective', 'Analyze flaky tests'); input(app, 'criteria', 'Explain the root cause'); submit(app)
  input(app, 'checkoutId', 'checkout-a'); submit(app)
  await click(app, 'savePlan'); await app.settle()
  const request = app.calls('taskCreate')[0]
  assert.equal(request.workMode, 'analysis')
  assert.deepEqual(request.source, { kind: 'technical' })
  assert.equal(request.scope.allowFileChanges, false)
  assert.equal(request.scope.allowCommands, true)
  assert.equal(request.codeTarget.checkoutId, 'checkout-a')
  assert.equal(app.calls('taskDispatch').length, 0)
})

test('analysis result can be explicitly accepted without code delivery and cannot enter publication flow', async t => {
  const task = taskFixture({ workMode: 'analysis' })
  const app = harness({ status, taskGet: task }); t.after(() => app.dispose())
  app.respond('taskAccept', () => {
    const accepted = { ...task, version: 6, status: 'accepted', acceptance: { acceptanceNotes: 'Root cause independently checked' } }
    app.data.taskGet = accepted
    return accepted
  })
  await openTask(app)
  click(app, 'changes')
  for (const key of ['submitReview', 'preparePreview', 'approvePush', 'approveMR']) assert.equal(text(app.tree).includes(key), false, key)
  click(app, 'history')
  const acceptButton = () => nodes(app.tree, node => node.type === 'button' && text(node).trim() === 'acceptResult').at(-1)
  assert.equal(acceptButton().props.disabled, true, 'acceptance requires explicit notes')
  input(app, 'acceptanceNotes', 'Root cause independently checked')
  assert.equal(acceptButton().props.disabled, false)
  acceptButton().props.onClick(); app.render()
  assert.equal(app.calls('taskAccept').length, 0, 'opening confirmation does not accept the report')
  assert.equal(button(app, 'confirm').props.disabled, false)
  await click(app, 'confirm'); await app.settle()
  const request = app.calls('taskAccept')[0]
  assert.deepEqual({ taskId: request.taskId, expectedVersion: request.expectedVersion, resultRevision: request.resultRevision, acceptanceNotes: request.acceptanceNotes, confirm: request.confirm }, { taskId: 'task-a', expectedVersion: 5, resultRevision: 2, acceptanceNotes: 'Root cause independently checked', confirm: true })
  assert.equal(Object.hasOwn(request, 'deliveryId'), false)
  for (const action of ['taskPrepareDelivery', 'taskPushDelivery', 'taskPublishDraft']) assert.equal(app.calls(action).length, 0, action)
  assert.ok(text(app.tree).includes('acceptedResult'))
})

test('a changed start plan identity invalidates the frozen dispatch confirmation', async t => {
  const created = taskFixture({ status: 'created', version: 1, result: undefined })
  const prepared = { ...created, version: 2, code: { ...created.code, plan } }
  const app = harness({ status, taskGet: created }); t.after(() => app.dispose())
  app.respond('taskPrepareDispatch', () => { app.data.taskGet = prepared; return prepared })
  await openTask(app)
  await click(app, 'checkPlan'); await app.settle()
  assert.equal(button(app, 'confirm').props.disabled, false)
  assert.equal(app.calls('taskDispatch').length, 0)
  app.data.taskGet = { ...prepared, code: { ...prepared.code, plan: { ...plan, id: 'replacement-plan' } } }
  click(app, 'refresh'); await app.settle()
  assert.equal(button(app, 'confirm').props.disabled, true)
  assert.ok(nodes(app.tree, node => node.props.role === 'alert' && text(node).includes('stalePreview')).length)
  button(app, 'confirm').props.onClick(); await app.settle()
  assert.equal(app.calls('taskDispatch').length, 0)
})

test('workflow uses service navigation rather than global navigation events or hidden publication writes', () => {
  assert.doesNotMatch(source, /CustomEvent|window\.dispatchEvent/)
  assert.doesNotMatch(source, /fetch\(['"]https?:/)
  assert.match(source, /window\.addEventListener\('beforeunload'/)
})
