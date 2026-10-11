import {
  createGame, startGame, startRound, play, legalMoves, viewFor, eventFor, describe, parseCard,
  mulberry32, RulesError, MAX_PLAYERS, MIN_PLAYERS,
  type GameEvent, type GameState, type Move, type PlayerId, type PublicState,
} from '@love-letter/engine';
import { Bot } from './bot.js';
import { hashToken, playerId, token as newToken } from './ids.js';

export interface Seat {
  id: PlayerId;
  name: string;
  tokenHash: string | null;
  bot: boolean;
  /** A human who left mid-game; a bot plays their cards. */
  gone: boolean;
  joinedAt: number;
}

export interface RoomOptions {
  /** Seconds a player has to move before a random legal move is played. 0 = no limit. */
  turnSeconds: number;
  /** Seconds to pause between rounds before the next one starts automatically. 0 = manual. */
  roundPauseSeconds: number;
  /** Tokens needed to win. 0 = the classic count for the number of players (7/5/4). */
  tokensToWin: number;
  /** How long bots appear to think before moving, in seconds. Gives humans time to read the table. */
  botSeconds: number;
}

export const DEFAULT_OPTIONS: RoomOptions = { turnSeconds: 0, roundPauseSeconds: 12, tokensToWin: 0, botSeconds: 3 };

export interface RoomSnapshot {
  id: string;
  createdAt: number;
  updatedAt: number;
  options: RoomOptions;
  hostId: PlayerId | null;
  seats: Seat[];
  game: GameState | null;
  seq: number;
}

/** A stored event: engine or room event with sequence number and timestamp. */
export type StoredEvent = GameEvent & { seq: number; ts: number };

export type Listener = (event: StoredEvent) => void;

export interface Persistence {
  saveRoom(room: Room): void;
  appendEvent(room: Room, event: StoredEvent): void;
}

export class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export class Room {
  id: string;
  createdAt: number;
  updatedAt: number;
  options: RoomOptions;
  hostId: PlayerId | null;
  seats: Seat[];
  game: GameState | null;
  events: StoredEvent[] = [];
  private seq = 0;
  private listeners = new Set<Listener>();
  private bots = new Map<PlayerId, Bot>();
  private turnTimer: NodeJS.Timeout | null = null;
  private roundTimer: NodeJS.Timeout | null = null;
  private botTimer: NodeJS.Timeout | null = null;

  constructor(snapshot: RoomSnapshot, events: StoredEvent[], private persist: Persistence) {
    this.id = snapshot.id;
    this.createdAt = snapshot.createdAt;
    this.updatedAt = snapshot.updatedAt;
    this.options = { ...DEFAULT_OPTIONS, ...snapshot.options };
    this.hostId = snapshot.hostId;
    this.seats = snapshot.seats;
    this.game = snapshot.game;
    this.events = events;
    this.seq = snapshot.seq;
    for (const s of this.seats) if (s.bot || s.gone) this.ensureBot(s.id);
    // Rebuild bot memory from the log, then resume any pending automation.
    for (const e of this.events) this.feedBots(e);
    this.scheduleAutomation();
  }

  static create(id: string, options: Partial<RoomOptions>, persist: Persistence): Room {
    const now = Date.now();
    const snap: RoomSnapshot = {
      id, createdAt: now, updatedAt: now, options: { ...DEFAULT_OPTIONS, ...options },
      hostId: null, seats: [], game: null, seq: 0,
    };
    const room = new Room(snap, [], persist);
    room.emit({ type: 'room_created' as never, options: room.options });
    return room;
  }

  snapshot(): RoomSnapshot {
    return {
      id: this.id, createdAt: this.createdAt, updatedAt: this.updatedAt, options: this.options,
      hostId: this.hostId, seats: this.seats, game: this.game, seq: this.seq,
    };
  }

  // ---- identity -------------------------------------------------------------

  seatByToken(token: string | undefined): Seat | undefined {
    if (!token) return undefined;
    const h = hashToken(token);
    return this.seats.find((s) => s.tokenHash === h);
  }

  seat(id: PlayerId): Seat {
    const s = this.seats.find((x) => x.id === id);
    if (!s) throw new HttpError(404, `no player ${id} in this room`);
    return s;
  }

  nameOf = (id: PlayerId): string => this.seats.find((s) => s.id === id)?.name ?? id;

  /** Resolve a player reference by id or name (case-insensitive). */
  resolvePlayer(ref: unknown): PlayerId | undefined {
    if (typeof ref !== 'string') return undefined;
    const s = ref.trim().toLowerCase();
    return this.seats.find((x) => x.id === s || x.name.toLowerCase() === s)?.id;
  }

  // ---- lobby ----------------------------------------------------------------

  join(name: string, opts: { bot?: boolean } = {}): { seat: Seat; token: string | null } {
    name = name.trim().replace(/\s+/g, ' ');
    if (!name || name.length > 24) throw new HttpError(400, 'name must be 1 to 24 characters');
    if (!/^[\p{L}\p{N} _.'-]+$/u.test(name)) throw new HttpError(400, 'name may only contain letters, numbers, spaces and _ . \' -');
    if (this.seats.some((s) => s.name.toLowerCase() === name.toLowerCase())) {
      throw new HttpError(409, `the name "${name}" is already taken in this room`);
    }
    if (this.game && this.game.phase !== 'lobby') throw new HttpError(409, 'the game has already started; you can watch at the events endpoint');
    if (this.seats.length >= MAX_PLAYERS) throw new HttpError(409, `the room is full (${MAX_PLAYERS} players)`);
    const tok = opts.bot ? null : newToken();
    const seat: Seat = {
      id: playerId(), name, tokenHash: tok ? hashToken(tok) : null, bot: !!opts.bot, gone: false, joinedAt: Date.now(),
    };
    this.seats.push(seat);
    if (seat.bot) this.ensureBot(seat.id);
    if (!this.hostId && !seat.bot) this.hostId = seat.id;
    this.emit({ type: 'joined' as never, player: seat.id, name: seat.name, bot: seat.bot, host: this.hostId === seat.id });
    return { seat, token: tok };
  }

  leave(id: PlayerId): void {
    const seat = this.seat(id);
    const inGame = this.game && this.game.phase !== 'lobby' && this.game.phase !== 'game_over';
    if (inGame && !seat.bot) {
      // Keep the seat; a bot takes over.
      seat.gone = true;
      seat.tokenHash = null;
      this.ensureBot(seat.id);
      this.emit({ type: 'left' as never, player: id, name: seat.name, replacedByBot: true });
    } else {
      this.seats = this.seats.filter((s) => s.id !== id);
      this.bots.delete(id);
      if (this.game?.phase === 'game_over') this.game = null;
      this.emit({ type: 'left' as never, player: id, name: seat.name, replacedByBot: false });
    }
    if (this.hostId === id) {
      const next = this.seats.find((s) => !s.bot && !s.gone);
      this.hostId = next?.id ?? null;
      if (next) this.emit({ type: 'host_changed' as never, player: next.id });
    }
    this.scheduleAutomation();
  }

  kick(byId: PlayerId, targetId: PlayerId): void {
    this.requireHost(byId);
    if (byId === targetId) throw new HttpError(400, 'use leave to remove yourself');
    this.leave(targetId);
  }

  requireHost(id: PlayerId): void {
    if (this.hostId !== id) throw new HttpError(403, `only the host (${this.nameOf(this.hostId ?? '')}) can do that`);
  }

  addBot(byId: PlayerId, name?: string): Seat {
    this.requireHost(byId);
    const names = ['Bot Beatrix', 'Bot Cyrano', 'Bot Dorian', 'Bot Eloise', 'Bot Fitz'];
    const pick = name ?? names.find((n) => !this.seats.some((s) => s.name === n)) ?? `Bot ${this.seats.length + 1}`;
    return this.join(pick, { bot: true }).seat;
  }

  setOptions(byId: PlayerId, patch: Partial<RoomOptions>): void {
    this.requireHost(byId);
    const next = { ...this.options };
    if (patch.turnSeconds !== undefined) {
      if (!Number.isInteger(patch.turnSeconds) || patch.turnSeconds < 0 || patch.turnSeconds > 3600) {
        throw new HttpError(400, 'turnSeconds must be an integer between 0 and 3600');
      }
      next.turnSeconds = patch.turnSeconds;
    }
    if (patch.roundPauseSeconds !== undefined) {
      if (!Number.isInteger(patch.roundPauseSeconds) || patch.roundPauseSeconds < 0 || patch.roundPauseSeconds > 600) {
        throw new HttpError(400, 'roundPauseSeconds must be an integer between 0 and 600');
      }
      next.roundPauseSeconds = patch.roundPauseSeconds;
    }
    if (patch.tokensToWin !== undefined) {
      if (!Number.isInteger(patch.tokensToWin) || patch.tokensToWin < 0 || patch.tokensToWin > 15) {
        throw new HttpError(400, 'tokensToWin must be an integer between 0 (classic) and 15');
      }
      next.tokensToWin = patch.tokensToWin;
    }
    if (patch.botSeconds !== undefined) {
      if (!Number.isInteger(patch.botSeconds) || patch.botSeconds < 0 || patch.botSeconds > 30) {
        throw new HttpError(400, 'botSeconds must be an integer between 0 and 30');
      }
      next.botSeconds = patch.botSeconds;
    }
    this.options = next;
    this.emit({ type: 'options_changed' as never, options: next });
    this.scheduleAutomation();
  }

  say(id: PlayerId, text: string): void {
    text = text.trim();
    if (!text || text.length > 500) throw new HttpError(400, 'message must be 1 to 500 characters');
    this.emit({ type: 'chat' as never, player: id, text });
  }

  // ---- game -----------------------------------------------------------------

  start(byId: PlayerId): void {
    this.requireHost(byId);
    if (this.game && this.game.phase !== 'lobby' && this.game.phase !== 'game_over') {
      throw new HttpError(409, 'a game is already in progress');
    }
    if (this.seats.length < MIN_PLAYERS) throw new HttpError(409, `need at least ${MIN_PLAYERS} players (add a bot?)`);
    // Dropped humans are removed before a fresh game.
    this.seats = this.seats.filter((s) => !s.gone);
    for (const s of this.seats) if (!s.bot) this.bots.delete(s.id);
    const game = createGame(this.seats.map((s) => ({ id: s.id, name: s.name })));
    this.applyStep(() => startGame(game, mulberry32(Math.floor(Math.random() * 2 ** 31)), { tokensToWin: this.options.tokensToWin }));
  }

  nextRound(byId: PlayerId | null): void {
    if (!this.game || this.game.phase !== 'round_over') throw new HttpError(409, 'no round is waiting to start');
    if (byId !== null) this.seat(byId);
    this.applyStep(() => startRound(this.game!, mulberry32(Math.floor(Math.random() * 2 ** 31))));
  }

  /** Parse a loosely-typed move from the API into engine terms. */
  parseMove(body: Record<string, unknown>): Move {
    const card = parseCard(body['card']);
    if (!card) throw new HttpError(400, 'card is required: a rank (1-8) or a name such as "guard"');
    const move: Move = { card: card.rank };
    if (body['target'] !== undefined && body['target'] !== null && body['target'] !== '') {
      const t = this.resolvePlayer(body['target']);
      if (!t) throw new HttpError(400, `unknown target "${body['target']}"; use a player name or id`);
      move.target = t;
    }
    if (body['guess'] !== undefined && body['guess'] !== null && body['guess'] !== '') {
      const g = parseCard(body['guess']);
      if (!g) throw new HttpError(400, `unknown card to guess "${body['guess']}"`);
      move.guess = g.rank;
    }
    return move;
  }

  play(id: PlayerId, move: Move): void {
    if (!this.game || this.game.phase === 'lobby') throw new HttpError(409, 'the game has not started yet');
    if (this.game.phase === 'round_over') throw new HttpError(409, 'the round is over; waiting for the next round to start');
    if (this.game.phase === 'game_over') throw new HttpError(409, 'the game is over');
    const game = this.game;
    try {
      this.applyStep(() => play(game, id, move));
    } catch (e) {
      if (e instanceof RulesError) throw new HttpError(422, e.message);
      throw e;
    }
  }

  private applyStep(step: () => { state: GameState; events: GameEvent[] }): void {
    const { state, events } = step();
    this.game = state;
    for (const e of events) this.emit(e);
    this.scheduleAutomation();
  }

  // ---- views ----------------------------------------------------------------

  view(viewer: PlayerId | null): RoomView {
    const me = viewer ? this.seats.find((s) => s.id === viewer) : undefined;
    return {
      id: this.id,
      options: this.options,
      hostId: this.hostId,
      seq: this.seq,
      players: this.seats.map((s) => ({ id: s.id, name: s.name, bot: s.bot, gone: s.gone, host: s.id === this.hostId })),
      you: me ? { id: me.id, name: me.name, host: me.id === this.hostId } : null,
      game: this.game ? viewFor(this.game, viewer) : null,
      turnDeadline: this.turnDeadline,
      nextRoundAt: this.nextRoundAt,
    };
  }

  /** Events since `since` (exclusive), filtered for the viewer. */
  eventsFor(viewer: PlayerId | null, since = 0): ViewEvent[] {
    return this.events.filter((e) => e.seq > since).map((e) => this.eventView(e, viewer));
  }

  eventView(e: StoredEvent, viewer: PlayerId | null): ViewEvent {
    const v = eventFor(e, viewer) as Record<string, unknown>;
    return { ...v, seq: e.seq, ts: e.ts, text: this.describe(v, viewer) } as ViewEvent;
  }

  describe(v: Record<string, unknown>, viewer: PlayerId | null): string {
    // Prefer the name recorded on the event: seats that left are no longer in the room.
    const who = (id: unknown) => (id === viewer ? 'You' : typeof v['name'] === 'string' ? v['name'] : this.nameOf(String(id)));
    switch (v['type']) {
      case 'room_created': return `Room ${this.id} created.`;
      case 'joined': return `${who(v['player'])} joined${v['bot'] ? ' (bot)' : ''}${v['host'] ? ' as host' : ''}.`;
      case 'left': return `${who(v['player'])} left${v['replacedByBot'] ? '; a bot plays their seat' : ''}.`;
      case 'host_changed': return `${who(v['player'])} ${v['player'] === viewer ? 'are' : 'is'} now the host.`;
      case 'options_changed': {
        const o = v['options'] as RoomOptions;
        return `Options: first to ${o.tokensToWin || 'the classic count'}, turn limit ${o.turnSeconds ? o.turnSeconds + 's' : 'none'}, round pause ${o.roundPauseSeconds}s, bots think for ${o.botSeconds}s.`;
      }
      case 'chat': return `${who(v['player'])}: ${v['text']}`;
      case 'timeout': return `${who(v['player'])} ran out of time; a random legal card was played.`;
      default: return describe(v, this.nameOf, viewer);
    }
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  get playerCount(): number { return this.seats.length; }

  // ---- internals ------------------------------------------------------------

  private emit(e: GameEvent): void {
    const stored: StoredEvent = { ...e, seq: ++this.seq, ts: Date.now() };
    this.events.push(stored);
    this.updatedAt = stored.ts;
    this.persist.appendEvent(this, stored);
    this.persist.saveRoom(this);
    this.feedBots(stored);
    for (const l of this.listeners) {
      try { l(stored); } catch { /* listener errors must not break the game */ }
    }
  }

  private ensureBot(id: PlayerId): Bot {
    let b = this.bots.get(id);
    if (!b) { b = new Bot(id); this.bots.set(id, b); }
    return b;
  }

  private feedBots(e: StoredEvent): void {
    for (const [id, bot] of this.bots) bot.observe(eventFor(e, id) as Record<string, unknown>);
  }

  private turnDeadline: number | null = null;
  private nextRoundAt: number | null = null;

  private scheduleAutomation(): void {
    if (this.turnTimer) { clearTimeout(this.turnTimer); this.turnTimer = null; }
    if (this.roundTimer) { clearTimeout(this.roundTimer); this.roundTimer = null; }
    if (this.botTimer) { clearTimeout(this.botTimer); this.botTimer = null; }
    this.turnDeadline = null;
    this.nextRoundAt = null;
    const g = this.game;
    if (!g) return;
    if (g.phase === 'playing' && g.turn) {
      const turn = g.turn;
      if (this.bots.has(turn)) {
        const think = Math.max(300, this.options.botSeconds * 1000 * (0.7 + Math.random() * 0.6));
        this.botTimer = setTimeout(() => this.botMove(turn), think);
      } else if (this.options.turnSeconds > 0) {
        this.turnDeadline = Date.now() + this.options.turnSeconds * 1000;
        this.turnTimer = setTimeout(() => this.timeoutMove(turn), this.options.turnSeconds * 1000);
      }
    } else if (g.phase === 'round_over' && this.options.roundPauseSeconds > 0) {
      this.nextRoundAt = Date.now() + this.options.roundPauseSeconds * 1000;
      this.roundTimer = setTimeout(() => {
        try { this.nextRound(null); } catch { /* state moved on */ }
      }, this.options.roundPauseSeconds * 1000);
    }
  }

  private botMove(id: PlayerId): void {
    const g = this.game;
    if (!g || g.phase !== 'playing' || g.turn !== id) return;
    const bot = this.bots.get(id);
    if (!bot) return;
    try {
      this.play(id, bot.choose(g));
    } catch {
      // Fall back to any legal move so a bot bug can't stall the table.
      const legal = legalMoves(g, id);
      if (legal[0]) this.play(id, legal[0]);
    }
  }

  private timeoutMove(id: PlayerId): void {
    const g = this.game;
    if (!g || g.phase !== 'playing' || g.turn !== id) return;
    const legal = legalMoves(g, id);
    const m = legal[Math.floor(Math.random() * legal.length)];
    if (!m) return;
    this.emit({ type: 'timeout' as never, player: id });
    this.play(id, m);
  }

  dispose(): void {
    if (this.turnTimer) clearTimeout(this.turnTimer);
    if (this.roundTimer) clearTimeout(this.roundTimer);
    if (this.botTimer) clearTimeout(this.botTimer);
    this.listeners.clear();
  }
}

export interface RoomView {
  id: string;
  options: RoomOptions;
  hostId: PlayerId | null;
  seq: number;
  players: { id: PlayerId; name: string; bot: boolean; gone: boolean; host: boolean }[];
  you: { id: PlayerId; name: string; host: boolean } | null;
  game: PublicState | null;
  turnDeadline: number | null;
  nextRoundAt: number | null;
}

export type ViewEvent = Record<string, unknown> & { seq: number; ts: number; type: string; text: string };
