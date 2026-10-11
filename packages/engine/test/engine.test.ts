import { describe, expect, it } from 'vitest';
import {
  createGame, startGame, startRound, play, legalMoves, validateMove, mulberry32, viewFor, eventFor, describe as text,
  RulesError, type GameState, type Rank, type LegalMove, DECK_SIZE,
} from '../src/index.js';

const names = (id: string) => id.toUpperCase();

function fresh(n = 3, seed = 1) {
  const players = ['a', 'b', 'c', 'd'].slice(0, n).map((id) => ({ id, name: id.toUpperCase() }));
  return startGame(createGame(players), mulberry32(seed));
}

/** Force a known layout for deterministic rule tests. */
function rig(state: GameState, hands: Record<string, Rank[]>, deck: Rank[], turn: string): GameState {
  const s = structuredClone(state);
  for (const p of s.players) { p.hand = hands[p.id] ?? []; p.protected = false; p.alive = true; }
  s.deck = deck;
  s.turn = turn;
  s.phase = 'playing';
  return s;
}

describe('setup', () => {
  it('deals one card each, burns one, and 3 face-up for two players', () => {
    const { state } = fresh(2);
    expect(state.faceUp).toHaveLength(3);
    expect(state.burned).not.toBeNull();
    expect(state.deck.length + state.faceUp.length + 1 + 3).toBe(DECK_SIZE); // starter holds 2
    expect(state.players.find((p) => p.id === state.turn)!.hand).toHaveLength(2);
  });
  it('uses no face-up cards for 3+ players and sets tokens to win', () => {
    expect(fresh(3).state.faceUp).toHaveLength(0);
    expect(fresh(3).state.tokensToWin).toBe(5);
    expect(fresh(4).state.tokensToWin).toBe(4);
    expect(fresh(2).state.tokensToWin).toBe(7);
  });
  it('rejects wrong player counts', () => {
    expect(() => startGame(createGame([{ id: 'a', name: 'A' }]), mulberry32(1))).toThrow(RulesError);
  });
  it('is deterministic for a seed', () => {
    expect(fresh(3, 42).state).toEqual(fresh(3, 42).state);
  });
});

describe('legal moves and the Countess', () => {
  it('forces the Countess with the King', () => {
    const s = rig(fresh().state, { a: [7, 6], b: [1], c: [1] }, [1, 1], 'a');
    expect(legalMoves(s, 'a')).toEqual([{ card: 7 }]);
    expect(validateMove(s, 'a', { card: 6, target: 'b' })).toMatch(/must play the Countess/);
  });
  it('forces the Countess with the Prince', () => {
    const s = rig(fresh().state, { a: [5, 7], b: [1], c: [1] }, [1, 1], 'a');
    expect(legalMoves(s, 'a')).toEqual([{ card: 7 }]);
  });
  it('allows Countess with other cards freely', () => {
    const s = rig(fresh().state, { a: [7, 1], b: [2], c: [3] }, [1, 1], 'a');
    const moves = legalMoves(s, 'a');
    expect(moves.some((m) => m.card === 7)).toBe(true);
    expect(moves.filter((m) => m.card === 1)).toHaveLength(2 * 7);
  });
  it('lists only unprotected living targets, and no-target play when none', () => {
    let s = rig(fresh().state, { a: [1, 3], b: [2], c: [3] }, [1, 1], 'a');
    s.players[1]!.protected = true;
    s.players[2]!.alive = false;
    expect(legalMoves(s, 'a')).toEqual([{ card: 1 }, { card: 3 }]);
    expect(validateMove(s, 'a', { card: 1 })).toBeUndefined();
    expect(validateMove(s, 'a', { card: 1, target: 'b', guess: 2 })).toMatch(/without a target/);
  });
  it('Prince may always target self', () => {
    const s = rig(fresh().state, { a: [5, 1], b: [2], c: [3] }, [1, 1], 'a');
    s.players[1]!.protected = true; s.players[2]!.protected = true;
    expect(legalMoves(s, 'a').filter((m) => m.card === 5)).toEqual([{ card: 5, target: 'a' }]);
  });
  it('explains an out-of-turn move', () => {
    const s = rig(fresh().state, { a: [1, 2], b: [3], c: [4] }, [1, 1], 'a');
    expect(validateMove(s, 'b', { card: 3, target: 'a' })).toMatch(/not your turn/);
  });
});

describe('card effects', () => {
  const base = () => fresh().state;

  it('Guard hit eliminates and reveals', () => {
    const s = rig(base(), { a: [1, 2], b: [5], c: [3] }, [1, 1, 1], 'a');
    const { state, events } = play(s, 'a', { card: 1, target: 'b', guess: 5 });
    expect(events.map((e) => e.type)).toEqual(['played', 'guard_guess', 'eliminated', 'drew', 'turn']);
    expect(state.players[1]!.alive).toBe(false);
    expect(state.players[1]!.discards).toEqual([5]);
    expect(state.turn).toBe('c');
  });
  it('Guard miss does nothing', () => {
    const s = rig(base(), { a: [1, 2], b: [5], c: [3] }, [1, 1, 1], 'a');
    const { state, events } = play(s, 'a', { card: 1, target: 'b', guess: 4 });
    expect(events[1]).toMatchObject({ type: 'guard_guess', hit: false });
    expect(state.players[1]!.alive).toBe(true);
    expect(state.turn).toBe('b');
  });
  it('Guard cannot guess Guard', () => {
    const s = rig(base(), { a: [1, 2], b: [5], c: [3] }, [1, 1, 1], 'a');
    expect(() => play(s, 'a', { card: 1, target: 'b', guess: 1 })).toThrow(/cannot guess Guard/);
  });
  it('Priest reveals privately', () => {
    const s = rig(base(), { a: [2, 1], b: [5], c: [3] }, [1, 1, 1], 'a');
    const { events } = play(s, 'a', { card: 2, target: 'b' });
    const look = events.find((e) => e.type === 'priest_look')!;
    expect(eventFor(look, 'a')).toMatchObject({ card: 5 });
    expect(eventFor(look, 'c')).not.toHaveProperty('card');
    expect(eventFor(look, null)).not.toHaveProperty('card');
  });
  it('Baron: lower loses, both see each other, tie does nothing', () => {
    let s = rig(base(), { a: [3, 6], b: [2], c: [3] }, [1, 1, 1], 'a');
    let r = play(s, 'a', { card: 3, target: 'b' });
    const cmp = r.events.find((e) => e.type === 'baron_compare')!;
    expect(cmp['loser']).toBe('b');
    expect(eventFor(cmp, 'a')).toMatchObject({ card: 2 });
    expect(eventFor(cmp, 'b')).toMatchObject({ card: 6 });
    expect(eventFor(cmp, 'c')).not.toHaveProperty('card');
    expect(r.state.players[1]!.alive).toBe(false);

    s = rig(base(), { a: [3, 2], b: [6], c: [3] }, [1, 1, 1], 'a');
    r = play(s, 'a', { card: 3, target: 'b' });
    expect(r.state.players[0]!.alive).toBe(false);

    s = rig(base(), { a: [3, 2], b: [2], c: [3] }, [1, 1, 1], 'a');
    r = play(s, 'a', { card: 3, target: 'b' });
    expect(r.events.find((e) => e.type === 'baron_compare')!['loser']).toBeNull();
    expect(r.state.players.every((p) => p.alive)).toBe(true);
  });
  it('Handmaid protects until next turn', () => {
    const s = rig(base(), { a: [4, 2], b: [1], c: [3] }, [1, 1, 1, 1], 'a');
    const r1 = play(s, 'a', { card: 4 });
    expect(r1.state.players[0]!.protected).toBe(true);
    // b's turn: a is not a legal target.
    expect(legalMoves(r1.state, 'b').some((m) => m.target === 'a')).toBe(false);
    expect(validateMove(r1.state, 'b', { card: 1, target: 'a', guess: 2 })).toMatch(/protected/);
  });
  it('Prince discards and redraws; Princess discard eliminates; empty deck draws burned', () => {
    let s = rig(base(), { a: [5, 2], b: [3], c: [4] }, [7, 1], 'a');
    let r = play(s, 'a', { card: 5, target: 'b' });
    expect(r.state.players[1]!.discards).toEqual([3]);
    expect(r.state.players[1]!.hand).toEqual([7, 1]); // redrew 7, then drew 1 for their turn
    expect(eventFor(r.events[1]!, 'b')).toMatchObject({ drew: 7 });
    expect(eventFor(r.events[1]!, 'a')).not.toHaveProperty('drew');

    s = rig(base(), { a: [5, 2], b: [8], c: [4] }, [1, 1], 'a');
    r = play(s, 'a', { card: 5, target: 'b' });
    expect(r.state.players[1]!.alive).toBe(false);
    expect(r.events.map((e) => e.type)).toContain('eliminated');

    s = rig(base(), { a: [5, 2], b: [3], c: [4] }, [1], 'a');
    s.burned = 6;
    r = play(s, 'a', { card: 5, target: 'a' });
    // a's own hand after playing prince was [2]; deck had one card for prince draw? No: deck [1] is drawn by prince.
    expect(r.state.players[0]!.hand).toEqual([1]);
    // Deck now empty -> round ends.
    expect(r.state.phase).toMatch(/round_over|game_over/);

    s = rig(base(), { a: [5, 2], b: [3], c: [4] }, [], 'a');
    s.burned = 6;
    r = play(s, 'a', { card: 5, target: 'a' });
    expect(r.state.players[0]!.hand).toEqual([6]);
    expect(r.events[1]).toMatchObject({ fromBurned: true });
  });
  it('King swaps hands and tells both', () => {
    const s = rig(base(), { a: [6, 2], b: [8], c: [4] }, [1, 1], 'a');
    const r = play(s, 'a', { card: 6, target: 'b' });
    expect(r.state.players[0]!.hand).toEqual([8]);
    expect(r.state.players[1]!.hand).toEqual([2, 1]); // b then drew
    const ev = r.events.find((e) => e.type === 'king_swap')!;
    expect(eventFor(ev, 'a')).toMatchObject({ received: 8 });
    expect(eventFor(ev, 'b')).toMatchObject({ received: 2 });
  });
  it('playing the Princess eliminates you', () => {
    const s = rig(base(), { a: [8, 2], b: [3], c: [4] }, [1, 1], 'a');
    const r = play(s, 'a', { card: 8 });
    expect(r.state.players[0]!.alive).toBe(false);
    expect(r.state.turn).toBe('b');
  });
});

describe('round and game end', () => {
  it('last player standing wins and starts next round', () => {
    const s = rig(fresh(2).state, { a: [1, 2], b: [5] }, [1, 1, 1], 'a');
    const r = play(s, 'a', { card: 1, target: 'b', guess: 5 });
    expect(r.state.phase).toBe('round_over');
    expect(r.state.players[0]!.tokens).toBe(1);
    expect(r.state.nextStarter).toBe('a');
    const ended = r.events.at(-1)!;
    expect(ended).toMatchObject({ type: 'round_ended', winners: ['a'], reason: 'last_standing' });
  });
  it('deck empty: highest hand wins, discards break ties', () => {
    let s = rig(fresh().state, { a: [1, 2], b: [5], c: [4] }, [], 'a');
    s.deck = []; // a plays its last card, deck empty => showdown
    let r = play(s, 'a', { card: 1, target: 'b', guess: 3 });
    expect(r.events.at(-1)).toMatchObject({ type: 'round_ended', reason: 'deck_empty', winners: ['b'] });

    s = rig(fresh().state, { a: [1, 5], b: [5], c: [4] }, [], 'a');
    s.players[0]!.discards = [1, 1];
    s.players[1]!.discards = [4];
    r = play(s, 'a', { card: 1, target: 'b', guess: 3 });
    // a holds 5 with discards [1,1,1]=3, b holds 5 with discards [4]=4 -> b wins
    expect((r.events.at(-1) as any).winners).toEqual(['b']);
  });
  it('awards the game at the token threshold', () => {
    const s = rig(fresh(2).state, { a: [1, 2], b: [5] }, [1, 1, 1], 'a');
    s.players[0]!.tokens = 6;
    const r = play(s, 'a', { card: 1, target: 'b', guess: 5 });
    expect(r.state.phase).toBe('game_over');
    expect(r.state.winner).toBe('a');
    expect(r.events.at(-1)).toMatchObject({ type: 'game_ended', winner: 'a' });
  });
});

describe('views and text', () => {
  it('hides other hands and the deck', () => {
    const { state } = fresh();
    const v = viewFor(state, 'a');
    expect(v.players.find((p) => p.id === 'a')!.hand).toBeDefined();
    expect(v.players.find((p) => p.id === 'b')!.hand).toBeUndefined();
    expect((v as any).deck).toBeUndefined();
    expect(viewFor(state, null).players.every((p) => p.hand === undefined)).toBe(true);
  });
  it('describes events for a viewer', () => {
    const s = rig(fresh().state, { a: [1, 2], b: [5], c: [3] }, [1, 1, 1], 'a');
    const { events } = play(s, 'a', { card: 1, target: 'b', guess: 5 });
    const lines = events.map((e) => text(eventFor(e, 'b'), names, 'b'));
    expect(lines[0]).toBe('A played the Guard on you, guessing Prince.');
    expect(lines[1]).toBe('Correct: you were holding the Prince.');
    expect(lines[2]).toMatch(/^You are out of the round/);
    const forC = text(eventFor(events.at(-1)!, 'c'), names, 'c');
    expect(forC).toMatch(/^Your turn\. Hand: /);
  });
});

describe('random full games', () => {
  it('always terminate with consistent state', () => {
    for (let seed = 1; seed <= 200; seed++) {
      const n = 2 + (seed % 3);
      const rng = mulberry32(seed);
      let { state } = fresh(n, seed);
      let guard = 0;
      while (state.phase !== 'game_over' && guard++ < 2000) {
        if (state.phase === 'round_over') {
          state = startRound(state, rng).state;
          continue;
        }
        const moves: LegalMove[] = legalMoves(state, state.turn!);
        expect(moves.length).toBeGreaterThan(0);
        const m = moves[Math.floor(rng.next() * moves.length)]!;
        state = play(state, state.turn!, m).state;
        // Card conservation.
        const total = state.deck.length + (state.burned ? 1 : 0) + state.faceUp.length +
          state.players.reduce((a, p) => a + p.hand.length + p.discards.length, 0);
        expect(total).toBe(DECK_SIZE);
      }
      expect(state.phase).toBe('game_over');
    }
  });
});
