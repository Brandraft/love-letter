import { Hono, type Context } from 'hono';
import { stream, streamSSE } from 'hono/streaming';
import { serveStatic } from '@hono/node-server/serve-static';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import QRCode from 'qrcode';
import { HttpError, Room, type RoomOptions, type StoredEvent } from './room.js';
import { roomId } from './ids.js';
import { Store } from './store.js';
import { homeText, roomText } from './onboarding.js';

export interface AppConfig {
  store: Store;
  /** Public base URL used in instructions, e.g. https://example.com. Derived from the request when null. */
  baseUrl: string | null;
  /** Directory of the built web client, or null to serve API only. */
  webDist: string | null;
  /** Rooms idle for longer than this are deleted. */
  roomTtlMs: number;
}

export class Rooms {
  rooms = new Map<string, Room>();
  constructor(private store: Store) {
    for (const r of store.loadRooms()) {
      const snap = JSON.parse(r.json);
      const events = r.events.map((e) => JSON.parse(e) as StoredEvent);
      this.rooms.set(r.id, new Room(snap, events, this.persistence));
    }
  }
  private persistence = {
    saveRoom: (room: Room) => this.store.saveRoom(room.id, JSON.stringify(room.snapshot()), room.updatedAt),
    appendEvent: (room: Room, e: StoredEvent) => this.store.appendEvent(room.id, e.seq, JSON.stringify(e)),
  };
  create(options: Partial<RoomOptions>): Room {
    let id = roomId();
    while (this.rooms.has(id)) id = roomId();
    const room = Room.create(id, options, this.persistence);
    this.rooms.set(id, room);
    return room;
  }
  get(id: string): Room {
    const r = this.rooms.get(id.toLowerCase());
    if (!r) throw new HttpError(404, `no room "${id}"`);
    return r;
  }
  sweep(ttlMs: number): void {
    const cutoff = Date.now() - ttlMs;
    for (const [id, r] of this.rooms) {
      if (r.updatedAt < cutoff) { r.dispose(); this.rooms.delete(id); this.store.deleteRoom(id); }
    }
  }
}

/** HTML only for clients that ask for it; `?text` (or `?format=text`) forces the plain-text instructions. */
const PREVIEW_BOTS = /twitterbot|facebookexternalhit|linkedinbot|slackbot|discordbot|telegrambot|whatsapp|embedly|pinterest|redditbot|mastodon|bluesky|applebot|googlebot|bingbot/i;
function wantsHtml(c: Context): boolean {
  const q = c.req.query();
  if ('text' in q || q['format'] === 'text') return false;
  const a = c.req.header('accept') ?? '';
  // Link-preview crawlers need the HTML (and its meta tags) regardless of their Accept header.
  return a.includes('text/html') || PREVIEW_BOTS.test(c.req.header('user-agent') ?? '');
}

function bearer(c: Context): string | undefined {
  const h = c.req.header('authorization');
  if (h?.toLowerCase().startsWith('bearer ')) return h.slice(7).trim();
  return c.req.query('token') ?? undefined;
}

/** Small per-IP token bucket, enough to keep a public tunnel from being a free database. */
class Limiter {
  private hits = new Map<string, { n: number; at: number }>();
  constructor(private max: number, private windowMs: number) {}
  take(key: string): boolean {
    const now = Date.now();
    const h = this.hits.get(key);
    if (!h || now - h.at > this.windowMs) { this.hits.set(key, { n: 1, at: now }); return true; }
    if (h.n >= this.max) return false;
    h.n += 1;
    return true;
  }
  sweep(): void {
    const now = Date.now();
    for (const [k, h] of this.hits) if (now - h.at > this.windowMs) this.hits.delete(k);
  }
}

const MAX_BODY = 16 * 1024;
const MAX_ROOMS = Number(process.env['MAX_ROOMS'] ?? 2000);

function clientIp(c: Context): string {
  return c.req.header('cf-connecting-ip') ?? c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ?? 'local';
}

export function createApp(cfg: AppConfig) {
  const rooms = new Rooms(cfg.store);
  const app = new Hono();
  const createLimit = new Limiter(20, 60_000);   // rooms per minute per IP
  const writeLimit = new Limiter(300, 60_000);   // other writes per minute per IP
  setInterval(() => { createLimit.sweep(); writeLimit.sweep(); }, 5 * 60 * 1000).unref();
  const base = (c: Context) => cfg.baseUrl ?? new URL(c.req.url).origin;
  const indexPath = cfg.webDist ? join(cfg.webDist, 'index.html') : null;

  setInterval(() => rooms.sweep(cfg.roomTtlMs), 10 * 60 * 1000).unref();

  // Setting any header here also sidesteps a hono/@hono/node-server bug: c.text() with no
  // headers builds a Response without init, and the HEAD→GET wrapper then dereferences
  // init.headers and 500s (node-server 1.19.17, hono 4.13.13). Hono's secureHeaders
  // middleware would also do, but one header is all we need.
  app.use('*', async (c, next) => { c.header('x-content-type-options', 'nosniff'); await next(); });

  app.onError((err, c) => {
    if (err instanceof HttpError) return c.json({ error: err.message }, err.status as 400);
    console.error(err);
    return c.json({ error: 'internal error' }, 500);
  });

  const html = (c: Context) => indexPath && existsSync(indexPath)
    ? c.html(readFileSync(indexPath, 'utf8'))
    : c.text('web client not built; API is available under /api', 503);

  app.get('/', (c) => wantsHtml(c) ? html(c) : c.text(homeText(base(c))));
  app.get('/r/:id', (c) => {
    if (wantsHtml(c)) return html(c);
    return c.text(roomText(rooms.get(c.req.param('id')), base(c)));
  });

  const api = new Hono();

  api.use('*', async (c, next) => {
    if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
      const len = Number(c.req.header('content-length') ?? 0);
      if (len > MAX_BODY) throw new HttpError(413, 'request body too large');
      if (!writeLimit.take(clientIp(c))) throw new HttpError(429, 'too many requests; slow down');
    }
    await next();
  });

  api.post('/rooms', async (c) => {
    if (!createLimit.take(clientIp(c))) throw new HttpError(429, 'too many rooms created from your address; try again in a minute');
    if (rooms.rooms.size >= MAX_ROOMS) throw new HttpError(503, 'the server is full; try again later');
    const body = await readJson(c);
    const room = rooms.create(pickOptions(body));
    return c.json({ id: room.id, url: `${base(c)}/r/${room.id}`, api: `${base(c)}/api/rooms/${room.id}`, options: room.options }, 201);
  });

  // A QR code of the invite link, for getting a phone to the table without typing.
  api.get('/rooms/:id/qr.svg', async (c) => {
    const room = rooms.get(c.req.param('id'));
    const svg = await QRCode.toString(`${base(c)}/r/${room.id}`, { type: 'svg', margin: 0, errorCorrectionLevel: 'M', color: { dark: '#1c1a17', light: '#0000' } });
    return c.body(svg, 200, { 'content-type': 'image/svg+xml', 'cache-control': 'public, max-age=3600' });
  });

  api.get('/rooms/:id', (c) => {
    const room = rooms.get(c.req.param('id'));
    const me = room.seatByToken(bearer(c));
    return c.json(room.view(me?.id ?? null));
  });

  api.get('/rooms/:id/help', (c) => c.text(roomText(rooms.get(c.req.param('id')), base(c))));

  api.post('/rooms/:id/join', async (c) => {
    const room = rooms.get(c.req.param('id'));
    const body = await readJson(c);
    const name = typeof body['name'] === 'string' ? body['name'] : '';
    const { seat, token } = room.join(name);
    return c.json({
      token, playerId: seat.id, name: seat.name, host: room.hostId === seat.id,
      api: `${base(c)}/api/rooms/${room.id}`,
      hint: `Stream events with: curl -sN ${base(c)}/api/rooms/${room.id}/events -H "authorization: Bearer ${token}"`,
    }, 201);
  });

  const withSeat = (c: Context<any, '/rooms/:id/*'>) => {
    const room = rooms.get(c.req.param('id') ?? '');
    const me = room.seatByToken(bearer(c));
    if (!me) throw new HttpError(401, 'missing or invalid token; join the room first');
    return { room, me };
  };

  api.post('/rooms/:id/leave', (c) => { const { room, me } = withSeat(c); room.leave(me.id); return c.json({ ok: true }); });
  api.post('/rooms/:id/start', (c) => { const { room, me } = withSeat(c); room.start(me.id); return c.json(room.view(me.id)); });
  api.post('/rooms/:id/next', (c) => { const { room, me } = withSeat(c); room.nextRound(me.id); return c.json(room.view(me.id)); });
  api.post('/rooms/:id/bots', async (c) => {
    const { room, me } = withSeat(c);
    const body = await readJson(c);
    const seat = room.addBot(me.id, typeof body['name'] === 'string' ? body['name'] : undefined);
    return c.json({ playerId: seat.id, name: seat.name }, 201);
  });
  api.post('/rooms/:id/kick', async (c) => {
    const { room, me } = withSeat(c);
    const body = await readJson(c);
    const t = room.resolvePlayer(body['player']);
    if (!t) throw new HttpError(400, 'player is required (name or id)');
    room.kick(me.id, t);
    return c.json({ ok: true });
  });
  api.patch('/rooms/:id/options', async (c) => {
    const { room, me } = withSeat(c);
    room.setOptions(me.id, pickOptions(await readJson(c)));
    return c.json(room.options);
  });
  api.post('/rooms/:id/say', async (c) => {
    const { room, me } = withSeat(c);
    const body = await readJson(c);
    room.say(me.id, typeof body['text'] === 'string' ? body['text'] : '');
    return c.json({ ok: true });
  });
  api.post('/rooms/:id/play', async (c) => {
    const { room, me } = withSeat(c);
    const body = await readJson(c);
    const move = room.parseMove(body);
    room.play(me.id, move);
    return c.json(room.view(me.id));
  });

  api.get('/rooms/:id/events', async (c) => {
    const room = rooms.get(c.req.param('id'));
    const me = room.seatByToken(bearer(c));
    const viewer = me?.id ?? null;
    const sinceRaw = c.req.query('since') ?? c.req.header('last-event-id') ?? '0';
    const since = Number.parseInt(String(sinceRaw), 10) || 0;
    const accept = c.req.header('accept') ?? '';
    const format = c.req.query('format')
      ?? (accept.includes('text/event-stream') ? 'sse' : accept.includes('application/json') ? 'json' : 'text');

    if (format === 'json') {
      // Optional long-poll: wait up to `wait` seconds for something newer than `since`.
      const wait = Math.min(Number(c.req.query('wait') ?? 0) || 0, 60);
      if (wait > 0 && room.eventsFor(viewer, since).length === 0) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(done, wait * 1000);
          const unsubscribe = room.subscribe(done);
          function done() { clearTimeout(timer); unsubscribe(); resolve(); }
        });
      }
      return c.json({ seq: room.view(viewer).seq, events: room.eventsFor(viewer, since) });
    }

    if (format === 'sse') {
      return streamSSE(c, async (s) => {
        let last = since;
        const send = (e: StoredEvent) => {
          last = e.seq;
          const v = room.eventView(e, viewer);
          return s.writeSSE({ id: String(e.seq), event: v.type, data: JSON.stringify(v) });
        };
        for (const e of room.events) if (e.seq > since) await send(e);
        const unsubscribe = room.subscribe((e) => { void send(e); });
        const ping = setInterval(() => { void s.writeSSE({ event: 'ping', data: String(last) }); }, 25_000);
        s.onAbort(() => { unsubscribe(); clearInterval(ping); });
        await new Promise<void>((resolve) => s.onAbort(resolve));
      });
    }

    // Plain text stream: one English line per event, kept open.
    c.header('content-type', 'text/plain; charset=utf-8');
    c.header('cache-control', 'no-cache');
    c.header('x-accel-buffering', 'no');
    return stream(c, async (s) => {
      const line = (e: StoredEvent) => {
        const v = room.eventView(e, viewer);
        let t = v.text;
        if (v.type === 'turn' && viewer && v['player'] === viewer) {
          t += `\n    -> curl -s -X POST ${base(c)}/api/rooms/${room.id}/play -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -d '{"card":"...","target":"...","guess":"..."}'`;
        }
        return s.write(`[${e.seq}] ${t}\n`);
      };
      if (since === 0) {
        await s.write(`# ${me ? `You are ${me.name}.` : 'Spectating.'} Streaming room ${room.id}. Ctrl-C to stop.\n`);
      }
      for (const e of room.events) if (e.seq > since) await line(e);
      const unsubscribe = room.subscribe((e) => { void line(e); });
      const ping = setInterval(() => { void s.write(''); }, 25_000);
      s.onAbort(() => { unsubscribe(); clearInterval(ping); });
      await new Promise<void>((resolve) => s.onAbort(resolve));
    });
  });

  app.route('/api', api);
  app.notFound((c) => c.req.path.startsWith('/api') ? c.json({ error: 'not found' }, 404) : wantsHtml(c) ? html(c) : c.text('not found', 404));

  if (cfg.webDist) {
    for (const path of ['/assets/*', '/cards/*', '/fonts/*', '/design/*', '/favicon.svg', '/og.png']) {
      app.use(path, serveStatic({ root: cfg.webDist }));
    }
  }

  return { app, rooms };
}

async function readJson(c: Context): Promise<Record<string, unknown>> {
  const ct = c.req.header('content-type') ?? '';
  const raw = await c.req.text();
  if (!raw.trim()) return {};
  if (!ct.includes('json') && !raw.trim().startsWith('{')) {
    // Be forgiving with curl -d 'card=guard&target=Bob'
    const out: Record<string, unknown> = {};
    for (const [k, v] of new URLSearchParams(raw)) out[k] = v;
    return out;
  }
  try {
    const v = JSON.parse(raw);
    if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
  } catch { /* fallthrough */ }
  throw new HttpError(400, 'body must be a JSON object');
}

function pickOptions(body: Record<string, unknown>): Partial<RoomOptions> {
  const out: Partial<RoomOptions> = {};
  for (const k of ['turnSeconds', 'roundPauseSeconds', 'tokensToWin', 'botSeconds'] as const) {
    const v = body[k];
    if (v === undefined) continue;
    const n = typeof v === 'string' ? Number(v) : v;
    if (typeof n !== 'number' || !Number.isFinite(n)) throw new HttpError(400, `${k} must be a number`);
    out[k] = Math.round(n);
  }
  return out;
}
