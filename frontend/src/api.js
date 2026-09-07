const BASE = '/api';

async function request(path, options = {}) {
  const res = await fetch(BASE + path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  let body = null;
  const text = await res.text();
  if (text) {
    try { body = JSON.parse(text); } catch { body = { raw: text }; }
  }
  if (!res.ok) {
    const err = new Error(body?.message || body?.error || `Error ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return body;
}

function rangeQs(range) {
  if (!range) return 'period=all';
  if (typeof range === 'string') return `period=${range}`;
  const p = new URLSearchParams();
  if (range.from) p.set('from', range.from);
  if (range.to) p.set('to', range.to);
  if (!range.from && !range.to) p.set('period', range.period || 'all');
  return p.toString();
}

export const api = {
  listClients: (params = {}) => {
    const qs = new URLSearchParams(
      Object.entries(params).filter(([, v]) => v != null && v !== '')
    ).toString();
    return request(`/clients${qs ? '?' + qs : ''}`);
  },
  getClient: (id) => request(`/clients/${id}`),
  listAssignees: () => request('/clients/assignees'),
  createClient: (data) => request('/clients', { method: 'POST', body: JSON.stringify(data) }),
  updateClient: (id, data) => request(`/clients/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteClient: (id) => request(`/clients/${id}`, { method: 'DELETE' }),

  stats: () => request('/stats'),
  tracker: () => request('/tracker'),
  reports: () => request('/reports'),
  analyticsSummary: (days) => request(`/analytics/summary${days ? `?days=${days}` : ''}`),
  listOrders: (clientId) => request(`/orders?clientId=${clientId}`),
  listClientFeedback: (clientId) => request(`/clients/${clientId}/feedback`),
  tapeQueue: () => request('/clients/tape-queue'),
  // Accepts either a named period or an explicit {from,to} — see
  // resolvePeriod() on the server, which is the single arbiter of both.
  revenue: (range) => request(`/orders/revenue?${rangeQs(range)}`),
  productMix: (range) => request(`/orders/product-mix?${rangeQs(range)}`),
  workshopStats: () => request('/orders/workshop-stats'),
  afterSalesStats: () => request('/orders/aftersales-stats'),
  sendDocket: (id) => request(`/orders/${id}/send-docket`, { method: 'POST' }),
  remindWorkshop: (id) => request(`/orders/${id}/remind-workshop`, { method: 'POST' }),
  regions: () => request('/regions'),
  products: () => request('/products'),
  createProduct: (body) => request('/products', { method: 'POST', body: JSON.stringify(body) }),
  updateProduct: (id, body) => request(`/products/${id}`, { method: 'PUT', body: JSON.stringify(body) }),
  deleteProduct: (id) => request(`/products/${id}`, { method: 'DELETE' }),
  sizes: () => request('/sizes'),
  sizeDistribution: () => request('/sizes/distribution'),
  createSize: (body) => request('/sizes', { method: 'POST', body: JSON.stringify(body) }),
  updateSize: (id, body) => request(`/sizes/${id}`, { method: 'PUT', body: JSON.stringify(body) }),
  deleteSize: (id) => request(`/sizes/${id}`, { method: 'DELETE' }),
  productionBoard: (includeDelivered, scope) =>
    request(`/orders/production-board?${new URLSearchParams({
      ...(includeDelivered ? { includeDelivered: '1' } : {}),
      ...(scope ? { scope } : {}),
    })}`),
  updateProduction: (orderId, body) =>
    request(`/orders/${orderId}/production`, { method: 'PATCH', body: JSON.stringify(body) }),
  redoOrder: (orderId, reason) =>
    request(`/orders/${orderId}/redo`, { method: 'POST', body: JSON.stringify({ reason }) }),
  createAlteration: (orderId, reason) =>
    request(`/orders/${orderId}/alterations`, { method: 'POST', body: JSON.stringify({ reason }) }),
  updateAlteration: (alterationId, body) =>
    request(`/orders/alterations/${alterationId}`, { method: 'PATCH', body: JSON.stringify(body) }),
  sendAlterationDetails: (alterationId) =>
    request(`/orders/alterations/${alterationId}/send-details`, { method: 'POST' }),

  getSettings: () => request('/settings'),
  updateSettings: (data) => request('/settings', { method: 'PUT', body: JSON.stringify(data) }),

  listMessages: (clientId) => request(`/clients/${clientId}/messages`),
  addMessage: (clientId, data) =>
    request(`/clients/${clientId}/messages`, { method: 'POST', body: JSON.stringify(data) }),
  deleteMessage: (clientId, msgId) =>
    request(`/clients/${clientId}/messages/${msgId}`, { method: 'DELETE' }),

  automationStatus: () => request('/automation/status'),
  automationRun: (dryRun) => request(`/automation/run${dryRun ? '?dryRun=1' : ''}`, { method: 'POST' }),
  automationTestEmail: (to) => request('/automation/test-email', { method: 'POST', body: JSON.stringify({ to }) }),

  contentOverview: () => request('/content/overview'),
  createPost: (data) => request('/content/posts', { method: 'POST', body: JSON.stringify(data) }),
  updatePost: (id, data) => request(`/content/posts/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  deletePost: (id) => request(`/content/posts/${id}`, { method: 'DELETE' }),
  createTopic: (data) => request('/content/topics', { method: 'POST', body: JSON.stringify(data) }),
  updateTopic: (id, data) => request(`/content/topics/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  deleteTopic: (id) => request(`/content/topics/${id}`, { method: 'DELETE' }),
  // L'image part telle quelle dans le corps de la requête — pas de multipart,
  // donc pas de FormData ni de dépendance côté serveur.
  uploadSlideImage: (id, n, file) => request(`/content/posts/${id}/slides/${n}/image`, {
    method: 'PUT', headers: { 'Content-Type': file.type }, body: file,
  }),
  deleteSlideImage: (id, n) => request(`/content/posts/${id}/slides/${n}/image`, { method: 'DELETE' }),
};
