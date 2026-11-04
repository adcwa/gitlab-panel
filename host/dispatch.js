import { fail, publicError, boundedBody } from './security.js'
export const READ_ACTIONS = ['status', 'projects', 'branches', 'mergeRequests', 'checkouts', 'environments', 'deliveries', 'getEnvironment', 'getDelivery']
export const USER_ACTIONS = ['saveConnection', 'disconnect', 'bindCheckout', 'plan', 'assertEnvironment', 'verifyDelivery', 'prepare', 'prepareDelivery', 'pushDelivery', 'publishDraft', 'inspectEnvironment', 'review', 'reviewRequests']
export async function dispatch(service, input, caller = 'agent') {
  try {
    if (!input || typeof input !== 'object' || Array.isArray(input)) fail('INVALID_ARGUMENT', 'An action object is required')
    const { action } = input
    if (![...READ_ACTIONS, ...USER_ACTIONS].includes(action)) fail('UNKNOWN_ACTION', 'Unknown GitLab operation')
    if (USER_ACTIONS.includes(action) && caller !== 'user') fail('USER_ONLY', 'Only the authenticated browser user may authorize this action')
    let payload
    if (action === 'status') payload = await service.status()
    else if (['checkouts', 'environments', 'deliveries'].includes(action)) payload = { items: await service.list(action) }
    else if (['projects', 'branches', 'mergeRequests', 'reviewRequests'].includes(action)) { const items = await service[action](input); payload = { items, hasMore: items.length === 30, page: input.page ?? 1 } }
    else if (action === 'plan') payload = await service.plan(input.codeTarget)
    else if (action === 'saveConnection') payload = await service.saveConnection(input)
    else if (action === 'bindCheckout') payload = await service.bindCheckout(input)
    else if (action === 'disconnect') payload = await service.disconnect(input)
    else if (action === 'getEnvironment') payload = await service.getEnvironment(input.environmentId ?? input.id)
    else if (['assertEnvironment', 'prepare'].includes(action)) payload = await service[action](input)
    else if (action === 'getDelivery') payload = await service.getDelivery(input.deliveryId ?? input.id)
    else payload = await service[action](input)
    return { ok: true, data: payload }
  } catch (error) { return { ok: false, error: publicError(error) } }
}
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } })
export function route(connection, service) { return { path: '/api/gitlab-panel', methods: ['POST'], requestBody: 'buffered', async fetch(request) {
  try {
    const admission = connection.admit(request)
    if ('rejection' in admission) return json({ ok: false, error: { code: 'UNAUTHENTICATED', message: 'Authenticated DSH connection required' } }, admission.rejection)
    if (request.method !== 'POST') return json({ ok: false, error: { code: 'INVALID_ARGUMENT', message: 'POST required' } }, 405)
    if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') return json({ ok: false, error: { code: 'INVALID_ARGUMENT', message: 'application/json required' } }, 415)
    if (Number(request.headers.get('content-length')) > 65536) return json({ ok: false, error: { code: 'REQUEST_TOO_LARGE', message: 'Request exceeds 64KiB' } }, 413)
    let input; try { input = JSON.parse(await boundedBody(request, 65536)) } catch (error) { return json({ ok: false, error: error?.code === 'RESPONSE_TOO_LARGE' ? { code: 'REQUEST_TOO_LARGE', message: 'Request exceeds 64KiB' } : { code: 'INVALID_ARGUMENT', message: 'Invalid JSON request' } }, error?.code === 'RESPONSE_TOO_LARGE' ? 413 : 400) }
    return json(await dispatch(service, input, admission.peer.id === connection.browserPeer.id ? 'user' : 'agent'))
  } catch (error) { return json({ ok: false, error: publicError(error) }, 500) }
} } }
export const toolParameters = { type: 'object', additionalProperties: false, required: ['action'], properties: {
  action: { type: 'string', enum: READ_ACTIONS, description: 'Remote reads and stored metadata only. Native planning, session checks and delivery reconciliation are performed by the user or scoped execution workflow.' },
  connectionId: { type: 'string' }, projectId: { oneOf: [{ type: 'string' }, { type: 'number' }] },
  search: { type: 'string', description: 'Project search, at most 256 characters.' }, page: { type: 'integer', description: 'Page 1..100; 30 records per page.' }, environmentId: { type: 'string', description: 'Stored environment identity for getEnvironment; does not resume its session.' }, deliveryId: { type: 'string', description: 'Stored delivery identity for getDelivery; stored status is not fresh verification.' },
} }
