import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { Store } from '../src/store.js';

function make() {
  const { app } = createApp({ store: new Store(':memory:'), baseUrl: 'http://test', webDist: null, roomTtlMs: 1e9 });
  const call = async (method: string, path: string, body?: unknown, token?: string, headers: Record<string, string> = {}) => {
    const res = await app.request(path, {
      method,
      headers: {
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...headers,
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    let json: any = null;
    try { json = JSON.parse(text); } catch { /* text */ }
    return { status: res.status, json, text, headers: res.headers };
  };
  return { app, call };
}

describe('content negotiation', () => {
  it('serves text instructions to curl and html-ish to browsers', async () => {
    const { call } = make();
    const t = await call('GET', '/');
    expect(t.status).toBe(200);
    expect(t.text).toMatch(/^LOVE LETTER/);
    const h = await call('GET', '/', undefined, undefined, { accept: 'text/html' });
    expect(h.status).toBe(503); // no web build in tests
  });
  it('room page explains how to join', async () => {
    const { call } = make();
    const r = await call('POST', '/api/rooms', {});
    const t = await call('GET', `/r/${r.json.id}`);
    expect(t.text).toContain(`/api/rooms/${r.json.id}/join`);
    expect(t.text).toContain('waiting in the lobby');
  });
});

describe('lobby', () => {
  it('first human is host; names unique; token required', async () => {
    const { call } = make();
    const r = await call('POST', '/api/rooms', { turnSeconds: 30 });
    expect(r.status).toBe(201);
    expect(r.json.options.turnSeconds).toBe(30);
    const id = r.json.id;
    const a = await call('POST', `/api/rooms/${id}/join`, { name: 'Alice' });
    expect(a.status).toBe(201);
    expect(a.json.host).toBe(true);
    const dup = await call('POST', `/api/rooms/${id}/join`, { name: 'alice' });
    expect(dup.status).toBe(409);
    const b = await call('POST', `/api/rooms/${id}/join`, { name: 'Bob' });
    expect(b.json.host).toBe(false);
    expect((await call('POST', `/api/rooms/${id}/start`)).status).toBe(401);
    expect((await call('POST', `/api/rooms/${id}/start`, undefined, b.json.token)).status).toBe(403);
    expect((await call('POST', `/api/rooms/${id}/bots`, {}, b.json.token)).status).toBe(403);
    const s = await call('POST', `/api/rooms/${id}/start`, undefined, a.json.token);
    expect(s.status).toBe(200);
    expect(s.json.game.phase).toBe('playing');
    expect((await call('POST', `/api/rooms/${id}/join`, { name: 'Late' })).status).toBe(409);
  });
});

describe('a full game over HTTP', () => {
  it('two scripted players finish a game using only public API data', async () => {
    const { call } = make();
    const room = (await call('POST', '/api/rooms', { roundPauseSeconds: 0 })).json.id;
    const tokens: Record<string, string> = {};
    for (const name of ['Ann', 'Ben', 'Cy']) {
      tokens[name] = (await call('POST', `/api/rooms/${room}/join`, { name })).json.token;
    }
    await call('POST', `/api/rooms/${room}/start`, undefined, tokens['Ann']);
    let guard = 0;
    for (;;) {
      if (guard++ > 3000) throw new Error('game did not finish');
      const view = (await call('GET', `/api/rooms/${room}`, undefined, tokens['Ann'])).json;
      const g = view.game;
      if (g.phase === 'game_over') break;
      if (g.phase === 'round_over') {
        expect((await call('POST', `/api/rooms/${room}/next`, undefined, tokens['Ben'])).status).toBe(200);
        continue;
      }
      const mover = view.players.find((p: any) => p.id === g.turn).name as string;
      const mine = (await call('GET', `/api/rooms/${room}`, undefined, tokens[mover])).json;
      expect(mine.game.legal.length).toBeGreaterThan(0);
      // Other players never see this hand.
      const other = Object.keys(tokens).find((n) => n !== mover)!;
      const theirs = (await call('GET', `/api/rooms/${room}`, undefined, tokens[other])).json;
      expect(theirs.game.players.find((p: any) => p.name === mover).hand).toBeUndefined();
      const m = mine.game.legal[Math.floor(Math.random() * mine.game.legal.length)];
      const res = await call('POST', `/api/rooms/${room}/play`, m, tokens[mover]);
      expect(res.status, res.text).toBe(200);
    }
    const spectator = (await call('GET', `/api/rooms/${room}/events?format=json`)).json;
    const ended = spectator.events.filter((e: any) => e.type === 'game_ended');
    expect(ended).toHaveLength(1);
    expect(spectator.events.some((e: any) => 'hand' in e || 'card' in e && e.type === 'drew')).toBe(false);
    // Private stream includes own hand.
    const own = (await call('GET', `/api/rooms/${room}/events?format=json`, undefined, tokens['Ann'])).json;
    expect(own.events.some((e: any) => e.type === 'turn' && Array.isArray(e.hand))).toBe(true);
    // since works
    const tail = (await call('GET', `/api/rooms/${room}/events?format=json&since=${own.seq - 2}`)).json;
    expect(tail.events).toHaveLength(2);
  });

  it('rejects illegal moves with an explanation and accepts names for cards and targets', async () => {
    const { call } = make();
    const room = (await call('POST', '/api/rooms', {})).json.id;
    const a = (await call('POST', `/api/rooms/${room}/join`, { name: 'Ann' })).json.token;
    const b = (await call('POST', `/api/rooms/${room}/join`, { name: 'Ben' })).json.token;
    await call('POST', `/api/rooms/${room}/start`, undefined, a);
    const view = (await call('GET', `/api/rooms/${room}`, undefined, a)).json;
    const moverTok = view.game.turn === view.you.id ? a : b;
    const otherTok = moverTok === a ? b : a;
    const bad = await call('POST', `/api/rooms/${room}/play`, { card: 'guard', target: 'Ann', guess: 'priest' }, otherTok);
    expect(bad.status).toBe(422);
    expect(bad.json.error).toMatch(/not your turn/);
    const nonsense = await call('POST', `/api/rooms/${room}/play`, { card: 'dragon' }, moverTok);
    expect(nonsense.status).toBe(400);
    const mine = (await call('GET', `/api/rooms/${room}`, undefined, moverTok)).json;
    const legal = mine.game.legal[0];
    const names = ['', 'Guard', 'Priest', 'Baron', 'Handmaid', 'Prince', 'King', 'Countess', 'Princess'];
    const byName: any = { card: names[legal.card] };
    if (legal.target) byName.target = mine.game.players.find((p: any) => p.id === legal.target).name.toUpperCase();
    if (legal.guess) byName.guess = names[legal.guess].toLowerCase();
    const ok = await call('POST', `/api/rooms/${room}/play`, byName, moverTok);
    expect(ok.status, ok.text).toBe(200);
  });

  it('a human who leaves mid-game is replaced by a bot', async () => {
    const { call } = make();
    const room = (await call('POST', '/api/rooms', {})).json.id;
    const a = (await call('POST', `/api/rooms/${room}/join`, { name: 'Ann' })).json.token;
    const b = (await call('POST', `/api/rooms/${room}/join`, { name: 'Ben' })).json.token;
    await call('POST', `/api/rooms/${room}/start`, undefined, a);
    expect((await call('POST', `/api/rooms/${room}/leave`, undefined, b)).status).toBe(200);
    const view = (await call('GET', `/api/rooms/${room}`, undefined, a)).json;
    expect(view.players.find((p: any) => p.name === 'Ben').gone).toBe(true);
    expect((await call('GET', `/api/rooms/${room}`, undefined, b)).json.you).toBeNull();
  });
});

describe('streams', () => {
  it('SSE emits backlog with ids', async () => {
    const { app, call } = make();
    const room = (await call('POST', '/api/rooms', {})).json.id;
    await call('POST', `/api/rooms/${room}/join`, { name: 'Ann' });
    const ac = new AbortController();
    const res = await app.request(`/api/rooms/${room}/events`, { headers: { accept: 'text/event-stream' }, signal: ac.signal });
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const reader = res.body!.getReader();
    let buf = '';
    while (!buf.includes('event: joined')) buf += new TextDecoder().decode((await reader.read()).value);
    expect(buf).toMatch(/id: 1\n/);
    expect(buf).toMatch(/"text":"Ann joined as host\."/);
    ac.abort();
  });
});

describe('options', () => {
  it('first-to and bot pace are configurable and validated', async () => {
    const { call } = make();
    const r = await call('POST', '/api/rooms', { tokensToWin: 3, botSeconds: 0 });
    expect(r.json.options).toMatchObject({ tokensToWin: 3, botSeconds: 0 });
    const h = await call('POST', `/api/rooms/${r.json.id}/join`, { name: 'Host' });
    const bad = await call('PATCH', `/api/rooms/${r.json.id}/options`, { tokensToWin: 99 }, h.json.token);
    expect(bad.status).toBe(400);
    await call('POST', `/api/rooms/${r.json.id}/bots`, {}, h.json.token);
    const s = await call('POST', `/api/rooms/${r.json.id}/start`, undefined, h.json.token);
    expect(s.status).toBe(200);
    expect(s.json.game.tokensToWin).toBe(3);
    const qr = await call('GET', `/api/rooms/${r.json.id}/qr.svg`);
    expect(qr.headers.get('content-type')).toContain('image/svg+xml');
    expect(qr.text).toContain('<svg');
  });
});
