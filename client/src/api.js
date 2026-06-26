export async function getMe() {
  const res = await fetch('/api/me', { credentials: 'include' });
  return res.json();
}

export async function ask(question, flow = 'xaa') {
  const res = await fetch('/api/ask', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ question, flow }),
  });
  if (!res.ok && res.status === 401) throw new Error('not_authenticated');
  return res.json();
}

export async function revokeSts() {
  const res = await fetch('/api/sts/revoke', {
    method: 'POST',
    credentials: 'include',
  });
  return res.json();
}

export async function logout() {
  await fetch('/api/logout', { method: 'POST', credentials: 'include' });
}

export function login() {
  window.location.href = '/api/login';
}
