import { CARDS, type GameState, type LegalMove, type PlayerId, type Rank, legalMoves } from '@love-letter/engine';

/**
 * A modest heuristic opponent. It remembers cards it has seen through the Priest,
 * Baron and King, counts what is left in the deck, and avoids obviously bad plays.
 */
export class Bot {
  /** What this bot believes other players hold, from private information. */
  private known = new Map<PlayerId, Rank>();
  /** Cards a player has been shown not to hold (public Guard misses). Cleared when they draw. */
  private notHeld = new Map<PlayerId, Set<Rank>>();

  constructor(readonly id: PlayerId) {}

  /** Feed the bot the events as it would see them (already filtered with eventFor). */
  observe(e: Record<string, unknown>): void {
    const p = String(e['player']);
    const t = String(e['target']);
    switch (e['type']) {
      case 'round_started':
        this.known.clear();
        this.notHeld.clear();
        break;
      case 'drew':
        // A new card in hand invalidates what we know they do not hold.
        if (p !== this.id) this.notHeld.delete(p);
        break;
      case 'priest_look':
        if (p === this.id && typeof e['card'] === 'number') this.known.set(t, e['card'] as Rank);
        break;
      case 'baron_compare':
        if (typeof e['card'] === 'number') this.known.set(p === this.id ? t : p, e['card'] as Rank);
        break;
      case 'king_swap':
        if (typeof e['received'] === 'number' && typeof e['gave'] === 'number') {
          // After a swap we know exactly what the other party holds: the card we handed over.
          this.known.set(p === this.id ? t : p, e['gave'] as Rank);
        } else {
          this.known.delete(p === this.id ? t : p);
        }
        break;
      case 'guard_guess':
        // A public miss: that player does not hold the guessed card. Remember it as a negative.
        if (p !== this.id && e['hit'] === false && typeof e['guess'] === 'number') {
          const t2 = String(e['target']);
          const set = this.notHeld.get(t2) ?? new Set<Rank>();
          set.add(e['guess'] as Rank);
          this.notHeld.set(t2, set);
        }
        break;
      case 'played':
        // A player who just played may still hold what we saw if they played the drawn card; be conservative.
        if (p !== this.id && this.known.get(p) === e['card']) this.known.delete(p);
        break;
      case 'prince_discard':
        this.known.delete(t);
        this.notHeld.delete(t);
        break;
      case 'eliminated':
        this.known.delete(p);
        break;
    }
  }

  choose(state: GameState, rng: () => number = Math.random): LegalMove {
    const moves = legalMoves(state, this.id);
    if (moves.length === 1) return moves[0]!;
    const me = state.players.find((p) => p.id === this.id)!;
    const unseen = this.unseenCounts(state);
    const scored = moves.map((m) => ({ m, s: this.score(m, me.hand, state, unseen) + rng() * 0.5 }));
    scored.sort((a, b) => b.s - a.s);
    return scored[0]!.m;
  }

  private unseenCounts(state: GameState): Map<Rank, number> {
    const counts = new Map<Rank, number>(CARDS.map((c) => [c.rank, c.count]));
    const seen: Rank[] = [...state.faceUp];
    for (const p of state.players) {
      seen.push(...p.discards);
      if (p.id === this.id) seen.push(...p.hand);
    }
    for (const r of seen) counts.set(r, (counts.get(r) ?? 0) - 1);
    return counts;
  }

  private score(m: LegalMove, hand: Rank[], state: GameState, unseen: Map<Rank, number>): number {
    // eslint-disable-next-line default-case
    const other = hand.find((c) => c !== m.card) ?? hand[0]!;
    const target = m.target ? state.players.find((p) => p.id === m.target) : undefined;
    const known = target ? this.known.get(target.id) : undefined;
    switch (m.card) {
      case 1: {
        if (!m.target) return 1;
        if (known !== undefined) return known === m.guess ? 100 : -5;
        if (this.notHeld.get(target!.id)?.has(m.guess!)) return -5;
        // Guess the most common unseen non-Guard card, weighted toward the high cards that threaten us.
        const n = unseen.get(m.guess!) ?? 0;
        const total = Array.from(unseen.entries()).filter(([r]) => r !== 1).reduce((a, [, c]) => a + Math.max(0, c), 0);
        const p = total > 0 ? n / total : 0;
        return 10 + p * 40 + (m.guess! >= 5 ? 3 : 0);
      }
      case 2:
        // Look at someone we know nothing about; prefer the player with the most tokens.
        return (known === undefined ? 12 : 6) + (target ? target.tokens : 0);
      case 3: {
        if (!m.target) return 1;
        if (known !== undefined) return other > known ? 90 : other === known ? 0 : -50;
        return other >= 6 ? 30 : other >= 4 ? 8 : -20;
      }
      case 4:
        // Protection matters most when we hold something worth protecting.
        return other >= 5 ? 32 : 22;
      case 5: {
        if (m.target === this.id) return other === 8 ? -100 : 2;
        if (known === 8) return 95;
        return known !== undefined && known >= 5 ? 20 : 15;
      }
      case 6:
        if (!m.target) return 1;
        if (known !== undefined) return known > other ? 40 : -10;
        return other <= 3 ? 20 : other === 8 ? -40 : -5;
      case 7:
        return 10;
      case 8:
        return -1000;
      default:
        return 0;
    }
  }
}
