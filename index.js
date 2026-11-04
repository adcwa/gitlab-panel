import { GitLabWorkspace } from './host/workspace.js'
import { dispatch, route, toolParameters } from './host/dispatch.js'
export { toolParameters }
export const inject = ['connection', 'tools', 'credentials', 'storageDomain']
export function apply(ctx) {
  const service = new GitLabWorkspace(ctx)
  // Cordis 4: set() only replaces an already-provided service. provide() owns registration.
  const provider = Object.fromEntries(['capabilities', 'plan', 'prepare', 'getEnvironment', 'assertEnvironment', 'prepareDelivery', 'pushDelivery', 'publishDraft', 'verifyDelivery', 'getDelivery', 'inspectEnvironment', 'readReview', 'review', 'reviewRequests'].map(name => [name, service[name].bind(service)]))
  ctx.effect(() => ctx.provide('gitlabWorkspace', Object.freeze(provider)), 'gitlab-panel: workspace provider')
  ctx.effect(() => async () => service.dispose(), 'gitlab-panel: drain durable state')
  ctx.effect(() => ctx.connection.fetch.register(route(ctx.connection, service)), 'gitlab-panel: authenticated API')
  ctx.effect(() => ctx.tools.register({
    name: 'gitlab_workbench',
    description: 'Read GitLab projects, branches and open merge requests; inspect stored checkout, worktree and delivery metadata. Start with status for connection ids. Does not inspect local Git, resume sessions or freshly verify a delivery. Credential changes, checkout binding, native preparation and publication belong to the authenticated user or scoped execution workflow.',
    parameters: toolParameters,
    output: { schema: { type: 'object' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    timeoutMs: 90000,
    execute: args => dispatch(service, args, 'agent'),
  }), 'gitlab-panel: read-only agent tool')
}
