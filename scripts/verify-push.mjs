/**
 * Verifies the two notification triggers on the server:
 *   1. a message from A to B  → a push of type "message"
 *   2. A starts a call         → a push of type "call" (ringing)
 * Both are proven by the [push] lines the server writes to its log.
 */
import WebSocket from 'ws';

const BASE = 'http://127.0.0.1:3910/chat';
const rnd = () => Math.random().toString(36).slice(2, 7);

async function api(path, { method = 'GET', token, body } = {}) {
  const r = await fetch(BASE + path, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, json: await r.json().catch(() => null) };
}

const reg = await api('/api/register', { method: 'POST', body: { username: `pushtest_${rnd()}`, password: 'testpassword', displayName: 'Push Test' } });
if (reg.status !== 201) { console.log('register failed', reg); process.exit(1); }
const me = reg.json;

// a direct chat with the superadmin (whose device holds the live push subscription)
const chat = await api('/api/chats', { method: 'POST', token: me.token, body: { memberIds: [1] } });
const chatId = chat.json.chat.id;
console.log('test account', me.user.username, '→ chat', chatId, 'with admin (id 1, has a subscribed device)');

// 1. message trigger
const msg = await api(`/api/chats/${chatId}/messages`, { method: 'POST', token: me.token, body: { body: 'push trigger check' } });
console.log('message sent:', msg.status);

// 2. call trigger
const ws = new WebSocket(`${BASE.replace('http', 'ws')}/ws?token=${me.token}`);
await new Promise((r) => ws.on('open', r));
ws.send(JSON.stringify({ t: 'call.start', chatId, kind: 'audio' }));
await new Promise((r) => {
  ws.on('message', (raw) => { const f = JSON.parse(raw); if (f.t === 'call.started' || f.t === 'call.incoming') r(); });
  setTimeout(r, 3000);
});
console.log('call started (ringing the other member)');
ws.send(JSON.stringify({ t: 'call.leave', callId: 'x' }));
ws.close();
await new Promise((r) => setTimeout(r, 600));
process.exit(0);
