/**
 * Realtime + call-signalling verification (no test framework needed).
 *   node test/realtime-check.mjs
 * Proves: two users exchange messages live, the admin mirror sees them,
 * and the full call handshake works (start → invite → accept → signal → leave).
 */
const BASE = process.env.BASE || 'http://127.0.0.1:3910/chat';
const WS = BASE.replace(/^http/, 'ws');
let pass = 0, fail = 0;
const ok = (cond, what, extra = '') => { if (cond) { pass++; console.log('  ✓', what); } else { fail++; console.log('  ✗', what, extra); } };

async function api(path, { method = 'GET', token, body } = {}) {
  const r = await fetch(BASE + path, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let j = null; try { j = await r.json(); } catch {}
  return { status: r.status, json: j };
}
const rnd = () => Math.random().toString(36).slice(2, 8);
const open = (token) => new Promise((res, rej) => {
  const ws = new WebSocket(`${WS}/ws?token=${token}`);
  const inbox = [];
  ws.addEventListener('message', (e) => { try { inbox.push(JSON.parse(e.data)); } catch {} });
  ws.addEventListener('open', () => res({ ws, inbox, send: (o) => ws.send(JSON.stringify(o)), wait: (t, ms = 5000) => waitFor(inbox, t, ms) }));
  ws.addEventListener('error', rej);
});
function waitFor(inbox, type, ms = 5000) {
  const t0 = Date.now();
  return new Promise((res) => {
    const tick = () => {
      const hit = inbox.find((m) => m.t === type);
      if (hit) return res(hit);
      if (Date.now() - t0 > ms) return res(null);
      setTimeout(tick, 60);
    };
    tick();
  });
}

const admin = await api('/api/login', { method: 'POST', body: { username: 'admin', password: process.env.ADMIN_PW } });
if (admin.status !== 200) { console.log('need ADMIN_PW env with the seeded admin password'); process.exit(2); }
const a = await api('/api/register', { method: 'POST', body: { username: `t_a_${rnd()}`, password: 'testpassword', displayName: 'Tester A' } });
const b = await api('/api/register', { method: 'POST', body: { username: `t_b_${rnd()}`, password: 'testpassword', displayName: 'Tester B' } });
ok(a.status === 201 && b.status === 201, 'two fresh accounts register');
const A = a.json, B = b.json;

console.log('\n— unique usernames —');
const dupCheck = await api('/api/register', { method: 'POST', body: { username: A.user.username, password: 'testpassword' } });
ok(dupCheck.status === 409 && dupCheck.json?.error?.code === 'username_taken', 're-registering the same username is refused (409 username_taken)');

console.log('\n— realtime messaging —');
const wsA = await open(A.token);
const wsB = await open(B.token);
const wsAdmin = await open(admin.json.token);
ok(!!wsA && !!wsB, 'both clients connected over WebSocket');
ok((await wsA.wait('ready'))?.user?.username === A.user.username, 'server sends a ready frame with the right user');

const chat = await api('/api/chats', { method: 'POST', token: A.token, body: { memberIds: [B.user.id] } });
ok(chat.status === 201, 'A opens a direct chat with B');
const chatId = chat.json.chat.id;

const body = `hello-${rnd()}`;
wsA.send({ t: 'msg.send', chatId, body, clientId: 'c1' });
const got = await wsB.wait('msg.new');
ok(got?.message?.body === body, 'B receives A\'s message live (msg.new)', JSON.stringify(got));
const ack = await wsA.wait('msg.ack');
ok(ack?.clientId === 'c1' && ack?.message?.body === body, 'A gets an ack for its own message (optimistic render)');

console.log('\n— typing + read receipts —');
wsA.send({ t: 'typing', chatId, on: true });
ok(!!(await wsB.wait('typing')), 'B sees A typing');
wsB.send({ t: 'read', chatId });
ok(!!(await wsA.wait('msg.read')), 'A gets the read receipt');
const listB = await api('/api/chats', { token: B.token });
ok(listB.json.chats.find((c) => c.id === chatId)?.unread === 0, 'unread count is 0 after reading');

console.log('\n— owner oversight —');
const mirror = await wsAdmin.wait('admin.message');
ok(mirror?.message?.body === body, 'admin live feed mirrors the private message');
const admRead = await api(`/api/admin/chats/${chatId}/messages`, { token: admin.json.token });
ok(admRead.json.messages.some((m) => m.body === body), 'admin can read the private chat transcript');
const admSearch = await api(`/api/admin/messages?q=${body}`, { token: admin.json.token });
ok(admSearch.json.messages.length === 1, 'admin global search finds it');
const forbidden = await api('/api/admin/users', { token: A.token });
ok(forbidden.status === 403, 'a normal user is refused the admin API (403)');

console.log('\n— call: start → invite → accept → signal → leave —');
wsA.send({ t: 'call.start', chatId, kind: 'video' });
const started = await wsA.wait('call.started');
ok(!!started?.callId, 'call created');
wsA.send({ t: 'call.invite', callId: started.callId, userIds: [B.user.id] });
const ring = await wsB.wait('call.incoming');
ok(ring?.callId === started.callId && ring?.from?.id === A.user.id, 'B is rung (call.incoming) with the caller identity');
wsB.send({ t: 'call.accept', callId: started.callId });
const joined = await wsA.wait('call.joined');
ok(joined?.participants?.length >= 2, 'both participants are in the room after accept', JSON.stringify(joined?.participants));
const sdp = { sdp: 'v=0 fake-offer', type: 'offer' };
wsA.send({ t: 'call.signal', callId: started.callId, to: B.user.id, data: sdp });
const sig = await wsB.wait('call.signal');
ok(sig?.from === A.user.id && sig?.data?.type === 'offer', 'SDP offer is relayed to the right peer (call.signal)');
wsB.send({ t: 'call.signal', callId: started.callId, to: A.user.id, data: { sdp: 'v=0 fake-answer', type: 'answer' } });
ok((await wsA.wait('call.signal'))?.data?.type === 'answer', 'SDP answer is relayed back');
wsA.send({ t: 'call.state', callId: started.callId, muted: true, camera: false });
const st = await wsB.wait('call.state');
ok(st?.muted === true && st?.userId === A.user.id, 'mute state is broadcast to the room');
wsB.send({ t: 'call.leave', callId: started.callId });
ok(!!(await wsA.wait('call.left')), 'B leaving is announced');
wsA.send({ t: 'call.leave', callId: started.callId });
// A 1-to-1 room retires with reason 'one_left' when either side hangs up; 'all_left'
// is the group-chat ending. Both mean the room correctly ended.
const endedReason = (await wsA.wait('call.ended'))?.reason;
ok(endedReason === 'all_left' || endedReason === 'one_left', `call ends when the last person leaves (reason: ${endedReason})`);

console.log('\n— security —');
const badWs = await new Promise((res) => {
  const ws = new WebSocket(`${WS}/ws?token=nonsense`);
  ws.addEventListener('open', () => res('opened'));
  ws.addEventListener('error', () => res('refused'));
  ws.addEventListener('close', () => res('refused'));
  setTimeout(() => res('timeout'), 3000);
});
ok(badWs === 'refused', 'WebSocket without a valid token is refused');

console.log(`\n${pass} passed, ${fail} failed`);
wsA.ws.close(); wsB.ws.close(); wsAdmin.ws.close();
process.exit(fail ? 1 : 0);
