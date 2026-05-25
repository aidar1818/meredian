// Тонкий клиент к /api/*.
// Все методы возвращают распарсенный JSON или бросают объект { status, error }.

(function (global) {
  async function call(method, url, body, opts) {
    const isForm = body instanceof FormData;
    const init = {
      method,
      credentials: 'include',
      headers: isForm ? {} : { 'Content-Type': 'application/json' },
    };
    if (body !== undefined && body !== null) init.body = isForm ? body : JSON.stringify(body);
    const res = await fetch(url, init);
    let data = null;
    const ct = res.headers.get('content-type') || '';
    if (ct.includes('application/json')) {
      data = await res.json().catch(() => null);
    }
    if (!res.ok) {
      // 401 → выкидываем на логин (кроме явного opts.silentAuth)
      if (res.status === 401 && !(opts && opts.silentAuth)) {
        window.location.href = '/login';
      }
      throw { status: res.status, error: (data && data.error) || `Ошибка ${res.status}` };
    }
    return data;
  }

  const api = {
    // ---- auth ----
    me:     () => call('GET',  '/api/auth/me', null, { silentAuth: true }),
    logout: () => call('POST', '/api/auth/logout'),

    // ---- trucks ----
    listTrucks: () => call('GET',  '/api/trucks'),
    getTruck:   (id) => call('GET', `/api/trucks/${encodeURIComponent(id)}`),
    createTruck: (payload) => call('POST', '/api/trucks', payload),
    patchTruck:  (id, payload) => call('PATCH', `/api/trucks/${encodeURIComponent(id)}`, payload),
    advanceTruck: (id) => call('POST', `/api/trucks/${encodeURIComponent(id)}/advance`),
    reportProblem: (id, reason) => call('POST', `/api/trucks/${encodeURIComponent(id)}/problem`, { reason }),
    resolveProblem: (id, note) => call('POST', `/api/trucks/${encodeURIComponent(id)}/problem/resolve`, { note }),

    // ---- assignment ----
    assignTruck:   (id, userId) => call('POST', `/api/trucks/${encodeURIComponent(id)}/assign`, userId ? { userId } : {}),
    unassignTruck: (id)         => call('POST', `/api/trucks/${encodeURIComponent(id)}/unassign`),

    // ---- files ----
    uploadFile: (id, kind, file) => {
      const fd = new FormData();
      fd.append('file', file);
      const url = kind === 'prelim'
        ? `/api/trucks/${encodeURIComponent(id)}/prelim-file`
        : `/api/trucks/${encodeURIComponent(id)}/declaration`;
      return call('POST', url, fd);
    },
    deleteFile: (id, kind) => {
      const url = kind === 'prelim'
        ? `/api/trucks/${encodeURIComponent(id)}/prelim-file`
        : `/api/trucks/${encodeURIComponent(id)}/declaration`;
      return call('DELETE', url);
    },
    fileDownloadUrl: (id, kind) =>
      kind === 'prelim'
        ? `/api/trucks/${encodeURIComponent(id)}/prelim-file/download`
        : `/api/trucks/${encodeURIComponent(id)}/declaration/download`,

    // ---- meta ----
    listClients: () => call('GET', '/api/clients'),
    listCustoms: () => call('GET', '/api/customs'),

    // ---- admin: roles ----
    listRoles:  () => call('GET',    '/api/roles'),
    createRole: (payload) => call('POST',   '/api/roles', payload),
    updateRole: (id, payload) => call('PATCH',  `/api/roles/${encodeURIComponent(id)}`, payload),
    deleteRole: (id) => call('DELETE', `/api/roles/${encodeURIComponent(id)}`),

    // ---- admin: users ----
    listUsers:  (q) => {
      const qs = q ? '?' + new URLSearchParams(q).toString() : '';
      return call('GET', '/api/users' + qs);
    },
    createUser: (payload) => call('POST', '/api/users', payload),
    setUserPassword: (id, password) => call('PATCH', `/api/users/${encodeURIComponent(id)}/password`, { password }),
    deactivateUser: (id) => call('POST', `/api/users/${encodeURIComponent(id)}/deactivate`),
    activateUser:   (id) => call('POST', `/api/users/${encodeURIComponent(id)}/activate`),

    listPages: () => call('GET', '/api/pages'),

    // ---- reports (admin) ----
    reportOperators: (from, to) => call('GET', `/api/reports/operators?from=${from}&to=${to}`),
    reportClients:   (from, to) => call('GET', `/api/reports/clients?from=${from}&to=${to}`),
    reportCustoms:   (from, to) => call('GET', `/api/reports/customs?from=${from}&to=${to}`),
    reportSummary:   (from, to) => call('GET', `/api/reports/summary?from=${from}&to=${to}`),
    reportTrucks:    (from, to, kind, value) =>
      call('GET', `/api/reports/trucks?from=${from}&to=${to}&kind=${encodeURIComponent(kind)}&value=${encodeURIComponent(value)}`),
  };

  global.MeridianAPI = api;
})(window);
