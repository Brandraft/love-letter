import { buildDeck, cardByRank, type Rank } from './cards.js';
import { shuffle, type Rng } from './rng.js';
import {
  RulesError,
  type GameEvent,
  type GameState,
  type LegalMove,
  type Move,
  type Player,
  type PlayerId,
  type Secrets,
} from './types.js';

export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 4;

export function tokensToWin(playerCount: number): number {
  switch (playerCount) {
    case 2: return 7;
    case 3: return 5;
    default: return 4;
  }
}

export interface Step {
  state: GameState;
  events: GameEvent[];
}

export function createGame(players: { id: PlayerId; name: string }[]): GameState {
  return {
    phase: 'lobby',
    players: players.map((p) => ({
      id: p.id, name: p.name, hand: [], discards: [], protected: false, alive: true, tokens: 0,
    })),
    deck: [],
    burned: null,
    faceUp: [],
    round: 0,
    turn: null,
    nextStarter: null,
    tokensToWin: tokensToWin(players.length),
    winner: null,
  };
}

function player(state: GameState, id: PlayerId): Player {
  const p = state.players.find((x) => x.id === id);
  if (!p) throw new RulesError(`unknown player ${id}`);
  return p;
}

function alive(state: GameState): Player[] {
  return state.players.filter((p) => p.alive);
}

function discard(p: Player, rank: Rank): void {
  const i = p.hand.indexOf(rank);
  if (i < 0) throw new RulesError(`${p.name} does not hold ${cardByRank(rank).name}`);
  p.hand.splice(i, 1);
  p.discards.push(rank);
}

export interface GameOptions {
  /** Tokens needed to win; omitted or 0 means the classic count for the player number. */
  tokensToWin?: number;
}

export function startGame(input: GameState, rng: Rng, opts: GameOptions = {}): Step {
  const state = structuredClone(input);
  if (state.phase !== 'lobby') throw new RulesError('game already started');
  if (state.players.length < MIN_PLAYERS || state.players.length > MAX_PLAYERS) {
    throw new RulesError(`need ${MIN_PLAYERS} to ${MAX_PLAYERS} players, have ${state.players.length}`);
  }
  state.tokensToWin = opts.tokensToWin && opts.tokensToWin > 0 ? Math.floor(opts.tokensToWin) : tokensToWin(state.players.length);
  const starter = state.players[Math.floor(rng.next() * state.players.length)]!;
  state.nextStarter = starter.id;
  const events: GameEvent[] = [{
    type: 'game_started',
    players: state.players.map((p) => ({ id: p.id, name: p.name })),
    tokensToWin: state.tokensToWin,
  }];
  const r = startRound(state, rng);
  return { state: r.state, events: events.concat(r.events) };
}

export function startRound(input: GameState, rng: Rng): Step {
  const state = structuredClone(input);
  if (state.phase !== 'lobby' && state.phase !== 'round_over') throw new RulesError('round in progress');
  state.round += 1;
  state.phase = 'playing';
  state.winner = null;
  const deck = shuffle(buildDeck(), rng);
  state.burned = deck.shift() ?? null;
  state.faceUp = state.players.length === 2 ? deck.splice(0, 3) : [];
  for (const p of state.players) {
    p.hand = [deck.shift()!];
    p.discards = [];
    p.protected = false;
    p.alive = true;
  }
  state.deck = deck;
  const starter = state.nextStarter ?? state.players[0]!.id;
  state.turn = starter;
  const secrets: Secrets = {};
  for (const p of state.players) secrets[p.id] = { hand: p.hand.slice() };
  const events: GameEvent[] = [{
    type: 'round_started',
    round: state.round,
    starter,
    faceUp: state.faceUp.slice(),
    deckSize: state.deck.length,
    secrets,
  }];
  events.push(...beginTurn(state));
  return { state, events };
}

/** The current player draws and is told their options. Mutates state. */
function beginTurn(state: GameState): GameEvent[] {
  const p = player(state, state.turn!);
  p.protected = false;
  const card = state.deck.shift();
  if (card === undefined) throw new RulesError('deck empty at turn start');
  p.hand.push(card);
  const events: GameEvent[] = [
    { type: 'drew', player: p.id, deckSize: state.deck.length, secrets: { [p.id]: { card } } },
    {
      type: 'turn',
      player: p.id,
      deckSize: state.deck.length,
      secrets: { [p.id]: { hand: p.hand.slice(), legal: legalMoves(state, p.id) } },
    },
  ];
  return events;
}

export function legalMoves(state: GameState, playerId: PlayerId): LegalMove[] {
  if (state.phase !== 'playing' || state.turn !== playerId) return [];
  const me = player(state, playerId);
  const hand = me.hand;
  let playable = Array.from(new Set(hand));
  // Countess must be played when held with King or Prince.
  if (hand.includes(7) && (hand.includes(5) || hand.includes(6))) playable = [7];
  const others = alive(state).filter((p) => p.id !== playerId && !p.protected);
  const moves: LegalMove[] = [];
  for (const card of playable.sort((a, b) => a - b)) {
    const def = cardByRank(card);
    if (def.targets === 'none') {
      moves.push({ card });
    } else if (def.targets === 'any') {
      // Prince: self is always a valid target.
      moves.push({ card, target: playerId });
      for (const o of others) moves.push({ card, target: o.id });
    } else if (others.length === 0) {
      moves.push({ card }); // played for no effect
    } else if (card === 1) {
      for (const o of others) for (let g = 2 as Rank; g <= 8; g++) moves.push({ card, target: o.id, guess: g });
    } else {
      for (const o of others) moves.push({ card, target: o.id });
    }
  }
  return moves;
}

/** Explain why a move is illegal, or return undefined if it's fine. */
export function validateMove(state: GameState, playerId: PlayerId, move: Move): string | undefined {
  if (state.phase !== 'playing') return 'no round in progress';
  if (state.turn !== playerId) return `it is not your turn (waiting on ${player(state, state.turn!).name})`;
  const me = player(state, playerId);
  if (!me.hand.includes(move.card)) {
    return `you do not hold the ${cardByRank(move.card).name}; your hand is ${me.hand.map((r) => cardByRank(r).name).join(' and ')}`;
  }
  if (me.hand.includes(7) && (me.hand.includes(5) || me.hand.includes(6)) && move.card !== 7) {
    const other = me.hand.includes(6) ? 'King' : 'Prince';
    return `you hold the Countess together with the ${other}, so you must play the Countess`;
  }
  const def = cardByRank(move.card);
  const others = alive(state).filter((p) => p.id !== playerId && !p.protected);
  if (def.targets === 'none') {
    if (move.target !== undefined) return `the ${def.name} does not take a target`;
    return undefined;
  }
  if (def.targets === 'any') {
    if (move.target === undefined) return `the ${def.name} needs a target (you may target yourself)`;
    const t = state.players.find((p) => p.id === move.target);
    if (!t) return `unknown target ${move.target}`;
    if (!t.alive) return `${t.name} is already out of this round`;
    if (t.protected && t.id !== playerId) return `${t.name} is protected by the Handmaid`;
    return undefined;
  }
  // targets === 'other'
  if (others.length === 0) {
    if (move.target !== undefined) return `everyone is protected or out, so the ${def.name} must be played without a target`;
    return undefined;
  }
  if (move.target === undefined) return `the ${def.name} needs a target: ${others.map((o) => o.name).join(', ')}`;
  if (move.target === playerId) return `you cannot target yourself with the ${def.name}`;
  const t = state.players.find((p) => p.id === move.target);
  if (!t) return `unknown target ${move.target}`;
  if (!t.alive) return `${t.name} is already out of this round`;
  if (t.protected) return `${t.name} is protected by the Handmaid`;
  if (move.card === 1) {
    if (move.guess === undefined) return 'the Guard needs a guess (any card except Guard)';
    if (move.guess === 1) return 'you cannot guess Guard';
  } else if (move.guess !== undefined) {
    return `only the Guard takes a guess`;
  }
  return undefined;
}

export function play(input: GameState, playerId: PlayerId, move: Move): Step {
  const problem = validateMove(input, playerId, move);
  if (problem) throw new RulesError(problem);
  const state = structuredClone(input);
  const me = player(state, playerId);
  const events: GameEvent[] = [];
  const def = cardByRank(move.card);
  discard(me, move.card);
  const played: GameEvent = { type: 'played', player: me.id, card: move.card };
  if (move.target !== undefined) played['target'] = move.target;
  if (move.guess !== undefined) played['guess'] = move.guess;
  events.push(played);

  const hasTarget = move.target !== undefined;
  const target = hasTarget ? player(state, move.target!) : undefined;

  if (def.targets === 'other' && !target) {
    events.push({ type: 'no_effect', player: me.id, card: move.card, reason: 'no valid targets' });
  } else {
    switch (move.card) {
      case 1: {
        const hit = target!.hand[0] === move.guess;
        events.push({ type: 'guard_guess', player: me.id, target: target!.id, guess: move.guess, hit });
        if (hit) eliminate(state, events, target!, 'guessed');
        break;
      }
      case 2: {
        events.push({
          type: 'priest_look', player: me.id, target: target!.id,
          secrets: { [me.id]: { card: target!.hand[0] } },
        });
        break;
      }
      case 3: {
        const mine = me.hand[0]!;
        const theirs = target!.hand[0]!;
        const loser = mine === theirs ? null : mine < theirs ? me : target!;
        events.push({
          type: 'baron_compare', player: me.id, target: target!.id, loser: loser ? loser.id : null,
          secrets: { [me.id]: { card: theirs }, [target!.id]: { card: mine } },
        });
        if (loser) eliminate(state, events, loser, 'baron');
        break;
      }
      case 4: {
        me.protected = true;
        events.push({ type: 'handmaid_protect', player: me.id });
        break;
      }
      case 5: {
        const t = target!;
        const discarded = t.hand[0]!;
        discard(t, discarded);
        if (discarded === 8) {
          events.push({ type: 'prince_discard', player: me.id, target: t.id, discarded });
          eliminate(state, events, t, 'princess', false);
        } else {
          let fromBurned = false;
          let drawn = state.deck.shift();
          if (drawn === undefined) {
            drawn = state.burned ?? undefined;
            state.burned = null;
            fromBurned = true;
          }
          if (drawn !== undefined) t.hand.push(drawn);
          events.push({
            type: 'prince_discard', player: me.id, target: t.id, discarded, fromBurned,
            secrets: { [t.id]: { drew: drawn } },
          });
        }
        break;
      }
      case 6: {
        const t = target!;
        const mine = me.hand[0]!;
        const theirs = t.hand[0]!;
        me.hand = [theirs];
        t.hand = [mine];
        events.push({
          type: 'king_swap', player: me.id, target: t.id,
          secrets: { [me.id]: { received: theirs, gave: mine }, [t.id]: { received: mine, gave: theirs } },
        });
        break;
      }
      case 7:
        break;
      case 8:
        eliminate(state, events, me, 'princess', false);
        break;
    }
  }

  // Advance.
  const remaining = alive(state);
  if (remaining.length <= 1) {
    endRound(state, events, 'last_standing');
  } else if (state.deck.length === 0) {
    endRound(state, events, 'deck_empty');
  } else {
    state.turn = nextAlive(state, me.id);
    events.push(...beginTurn(state));
  }
  return { state, events };
}

function nextAlive(state: GameState, from: PlayerId): PlayerId {
  const ids = state.players.map((p) => p.id);
  let i = ids.indexOf(from);
  for (let n = 0; n < ids.length; n++) {
    i = (i + 1) % ids.length;
    if (state.players[i]!.alive) return ids[i]!;
  }
  throw new RulesError('no alive players');
}

function eliminate(state: GameState, events: GameEvent[], p: Player, reason: string, revealHand = true): void {
  p.alive = false;
  p.protected = false;
  const card = p.hand[0];
  if (revealHand && card !== undefined) {
    p.hand = [];
    p.discards.push(card);
  }
  const ev: GameEvent = { type: 'eliminated', player: p.id, reason };
  if (revealHand && card !== undefined) ev['card'] = card;
  events.push(ev);
}

function endRound(state: GameState, events: GameEvent[], reason: 'last_standing' | 'deck_empty'): void {
  const contenders = alive(state);
  let winners: Player[];
  if (contenders.length === 1) {
    winners = contenders;
  } else {
    const best = Math.max(...contenders.map((p) => p.hand[0] ?? 0));
    const top = contenders.filter((p) => (p.hand[0] ?? 0) === best);
    if (top.length === 1) {
      winners = top;
    } else {
      const sum = (p: Player) => p.discards.reduce((a, b) => a + b, 0);
      const bestSum = Math.max(...top.map(sum));
      winners = top.filter((p) => sum(p) === bestSum);
    }
  }
  for (const w of winners) w.tokens += 1;
  const hands: Record<PlayerId, Rank> = {};
  for (const p of contenders) if (p.hand[0] !== undefined) hands[p.id] = p.hand[0];
  const tokens: Record<PlayerId, number> = {};
  for (const p of state.players) tokens[p.id] = p.tokens;
  state.turn = null;
  state.nextStarter = winners[0]!.id;
  state.phase = 'round_over';
  events.push({
    type: 'round_ended', round: state.round, reason,
    winners: winners.map((w) => w.id), hands, tokens, tokensToWin: state.tokensToWin,
  });
  const champion = winners.find((w) => w.tokens >= state.tokensToWin);
  if (champion) {
    state.phase = 'game_over';
    state.winner = champion.id;
    events.push({ type: 'game_ended', winner: champion.id, tokens });
  }
}

/** The state as one player (or a spectator, when viewer is null) is allowed to see it. */
export function viewFor(state: GameState, viewer: PlayerId | null): PublicState {
  return {
    phase: state.phase,
    round: state.round,
    turn: state.turn,
    tokensToWin: state.tokensToWin,
    winner: state.winner,
    deckSize: state.deck.length,
    faceUp: state.faceUp.slice(),
    players: state.players.map((p) => ({
      id: p.id,
      name: p.name,
      alive: p.alive,
      protected: p.protected,
      tokens: p.tokens,
      discards: p.discards.slice(),
      handSize: p.hand.length,
      ...(p.id === viewer ? { hand: p.hand.slice() } : {}),
    })),
    ...(viewer && state.turn === viewer ? { legal: legalMoves(state, viewer) } : {}),
  };
}

export interface PublicPlayer {
  id: PlayerId;
  name: string;
  alive: boolean;
  protected: boolean;
  tokens: number;
  discards: Rank[];
  handSize: number;
  /** Only present for the viewer's own seat. */
  hand?: Rank[];
}

export interface PublicState {
  phase: GameState['phase'];
  round: number;
  turn: PlayerId | null;
  tokensToWin: number;
  winner: PlayerId | null;
  deckSize: number;
  faceUp: Rank[];
  players: PublicPlayer[];
  /** Only present when it is the viewer's turn. */
  legal?: LegalMove[];
}

/** Strip secrets from an event, merging in the viewer's own. */
export function eventFor(event: GameEvent, viewer: PlayerId | null): Record<string, unknown> {
  const { secrets, ...pub } = event;
  if (viewer && secrets && secrets[viewer]) return { ...pub, ...secrets[viewer] };
  return pub;
}
