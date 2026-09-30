'use strict';

// Thin fetch wrapper for the backend. Errors carry the server error code so
// the UI can show a translated message (ui.errors.<code>).
window.Api = (() => {
  class ApiError extends Error {
    constructor(status, code, detail, extra) {
      super(detail || code);
      this.status = status;
      this.code = code;
      this.detail = detail;
      Object.assign(this, extra);
    }
  }

  async function request(method, url, body) {
    const opts = { method, headers: {}, credentials: 'same-origin' };
    if (body !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    const res = await fetch(url, opts);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new ApiError(res.status, data.error || 'internal', data.detail, data);
      if (res.status === 401 && data.error === 'unauthorized') window.dispatchEvent(new Event('auth-expired'));
      throw err;
    }
    return data;
  }

  // Stream a chat turn. Parses the server's SSE (event:/data: frames) and
  // calls onEvent(name, data). Resolves when the stream ends.
  async function streamChat(conversationId, body, onEvent, signal) {
    const res = await fetch(`/api/conversations/${conversationId}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(body),
      signal,
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      if (res.status === 401) window.dispatchEvent(new Event('auth-expired'));
      throw new ApiError(res.status, data.error || 'internal', data.detail);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        let event = 'message';
        let data = '';
        for (const line of frame.split('\n')) {
          if (line.startsWith('event:')) event = line.slice(6).trim();
          else if (line.startsWith('data:')) data += line.slice(5).trim();
        }
        if (data) onEvent(event, JSON.parse(data));
      }
    }
  }

  // Upload a File as the raw request body; the server stores it and returns
  // its metadata ({ id, name, kind, size, ... }).
  async function upload(file) {
    const res = await fetch('/api/uploads', {
      method: 'POST',
      headers: { 'Content-Type': file.type || 'application/octet-stream', 'X-File-Name': encodeURIComponent(file.name) },
      credentials: 'same-origin',
      body: file,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (res.status === 401) window.dispatchEvent(new Event('auth-expired'));
      throw new ApiError(res.status, data.error || 'internal', data.detail);
    }
    return data;
  }

  return {
    ApiError,
    upload,
    get: (u) => request('GET', u),
    post: (u, b) => request('POST', u, b || {}),
    patch: (u, b) => request('PATCH', u, b),
    del: (u) => request('DELETE', u),
    streamChat,
  };
})();
