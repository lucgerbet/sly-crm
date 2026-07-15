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

  getSettings: () => request('/settings'),
  updateSettings: (data) => request('/settings', { method: 'PUT', body: JSON.stringify(data) }),

  listMessages: (clientId) => request(`/clients/${clientId}/messages`),
  addMessage: (clientId, data) =>
    request(`/clients/${clientId}/messages`, { method: 'POST', body: JSON.stringify(data) }),
  deleteMessage: (clientId, msgId) =>
    request(`/clients/${clientId}/messages/${msgId}`, { method: 'DELETE' }),
};
