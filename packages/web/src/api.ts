import type { LegalMove, PublicState, Rank } from '@love-letter/engine';

export interface RoomView {
  id: string;
  options: { turnSeconds: number; roundPauseSeconds: number; tokensToWin: number; botSeconds: number };
  hostId: string | null;
  seq: number;
  players: { id: string; name: string; bot: boolean; gone: boolean; host: boolean }[];
  you: { id: string; name: string; host: boolean } | null;
  game: PublicState | null;
  turnDeadline: number | null;
  nextRoundAt: number | null;
}

export type ViewEvent = Record<string, unknown> & { seq: number; ts: number; type: string; text: string };

export class ApiError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

const tokenKey = (room: string) => `love-letter:token:${room}`;
export const getToken = (room: string) => localStorage.getItem(tokenKey(room));
export const setToken = (room: string, t: string | null) =>
  t ? localStorage.setItem(tokenKey(room), t) : localStorage.removeItem(tokenKey(room));
export const getName = () => localStorage.getItem('love-letter:name') ?? '';
export const setName = (n: string) => localStorage.setItem('love-letter:name', n);

async function req<T>(method: string, path: string, body?: unknown, token?: string | null): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: {
      accept: 'application/json',
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data: any = null;
  try { data = JSON.parse(text); } catch { /* not json */ }
  if (!res.ok) throw new ApiError(res.status, data?.error ?? res.statusText);
  return data as T;
}

export const api = {
  createRoom: (opts: Partial<RoomView['options']> = {}) =>
    req<{ id: string; url: string }>('POST', '/api/rooms', opts),
  view: (room: string, token: string | null) => req<RoomView>('GET', `/api/rooms/${room}`, undefined, token),
  join: (room: string, name: string) =>
    req<{ token: string; playerId: string; name: string }>('POST', `/api/rooms/${room}/join`, { name }),
  leave: (room: string, token: string) => req('POST', `/api/rooms/${room}/leave`, undefined, token),
  start: (room: string, token: string) => req<RoomView>('POST', `/api/rooms/${room}/start`, undefined, token),
  next: (room: string, token: string) => req<RoomView>('POST', `/api/rooms/${room}/next`, undefined, token),
  addBot: (room: string, token: string) => req('POST', `/api/rooms/${room}/bots`, {}, token),
  kick: (room: string, token: string, player: string) => req('POST', `/api/rooms/${room}/kick`, { player }, token),
  options: (room: string, token: string, o: Partial<RoomView['options']>) =>
    req('PATCH', `/api/rooms/${room}/options`, o, token),
  say: (room: string, token: string, text: string) => req('POST', `/api/rooms/${room}/say`, { text }, token),
  play: (room: string, token: string, move: LegalMove) => req<RoomView>('POST', `/api/rooms/${room}/play`, move, token),
  events: (room: string, token: string | null, since = 0) =>
    req<{ seq: number; events: ViewEvent[] }>('GET', `/api/rooms/${room}/events?format=json&since=${since}`, undefined, token),
};

/** Subscribe to the room's SSE stream. Returns an unsubscribe function. */
export function subscribe(
  room: string,
  token: string | null,
  since: number,
  onEvent: (e: ViewEvent) => void,
  onStatus: (connected: boolean) => void,
): () => void {
  const url = `/api/rooms/${room}/events?since=${since}${token ? `&token=${encodeURIComponent(token)}` : ''}`;
  const es = new EventSource(url);
  es.onopen = () => onStatus(true);
  es.onerror = () => onStatus(false);
  es.onmessage = (m) => onEvent(JSON.parse(m.data));
  // Named events (we set event: <type>) don't fire onmessage; listen generically.
  const types = ['room_created', 'joined', 'left', 'host_changed', 'options_changed', 'chat', 'timeout',
    'game_started', 'round_started', 'drew', 'turn', 'played', 'guard_guess', 'priest_look', 'baron_compare',
    'handmaid_protect', 'prince_discard', 'king_swap', 'eliminated', 'no_effect', 'round_ended', 'game_ended'];
  for (const t of types) es.addEventListener(t, (m) => onEvent(JSON.parse((m as MessageEvent).data)));
  return () => es.close();
}

export type { LegalMove, PublicState, Rank };
