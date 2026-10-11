import { cardByRank, type Rank } from './cards.js';
import type { LegalMove, PlayerId } from './types.js';

export type Names = (id: PlayerId) => string;

function card(r: unknown): string {
  return typeof r === 'number' ? cardByRank(r).name : '?';
}

function cards(rs: unknown): string {
  return Array.isArray(rs) ? rs.map(card).join(' and ') : '?';
}

/**
 * Render a viewer-filtered event (see eventFor) as one line of English.
 * `me` is the viewer's player id so the line can say "you".
 */
export function describe(e: Record<string, unknown>, names: Names, me: PlayerId | null): string {
  const who = (id: unknown): string => (id === me ? 'You' : names(String(id)));
  const whom = (id: unknown): string => (id === me ? 'you' : names(String(id)));
  const poss = (id: unknown): string => (id === me ? 'your' : `${names(String(id))}'s`);
  const p = e['player'];
  const t = e['target'];
  switch (e['type']) {
    case 'game_started': {
      const ps = (e['players'] as { name: string }[]).map((x) => x.name).join(', ');
      return `Game started with ${ps}. First to ${e['tokensToWin']} tokens wins.`;
    }
    case 'round_started': {
      let s = `Round ${e['round']} begins. ${who(e['starter'])} ${e['starter'] === me ? 'go' : 'goes'} first.`;
      const fu = e['faceUp'] as Rank[];
      if (fu.length) s += ` Set aside face up: ${cards(fu)}.`;
      if ('hand' in e) s += ` Your hand: ${cards(e['hand'])}.`;
      return s;
    }
    case 'drew':
      return 'card' in e ? `You drew the ${card(e['card'])}.` : `${who(p)} drew a card.`;
    case 'turn': {
      if ('hand' in e) {
        return `Your turn. Hand: ${cards(e['hand'])}. Options: ${describeMoves(e['legal'] as LegalMove[], names)}`;
      }
      return `${who(p)}'s turn.`;
    }
    case 'played': {
      let s = `${who(p)} played the ${card(e['card'])}`;
      if (t !== undefined) s += ` on ${t === p ? (p === me ? 'yourself' : 'themselves') : whom(t)}`;
      if (e['guess'] !== undefined) s += `, guessing ${card(e['guess'])}`;
      return s + '.';
    }
    case 'guard_guess':
      return e['hit']
        ? `Correct: ${whom(t)} ${t === me ? 'were' : 'was'} holding the ${card(e['guess'])}.`
        : `Wrong: ${whom(t)} ${t === me ? 'are' : 'is'} not holding the ${card(e['guess'])}.`;
    case 'priest_look':
      return 'card' in e
        ? `${poss(t)} hand is the ${card(e['card'])}.`
        : `${who(p)} looked at ${poss(t)} hand.`;
    case 'baron_compare': {
      const l = e['loser'];
      let s = 'card' in e ? `${who(p === me ? t : p)} ${p === me ? 'hold' : 'holds'} the ${card(e['card'])}. ` : '';
      if (p === me && 'card' in e) s = `${whom(t)} ${t === me ? 'hold' : 'holds'} the ${card(e['card'])}. `;
      if (l === null) s += 'The hands are equal; nothing happens.';
      else s += `${who(l)} ${l === me ? 'have' : 'has'} the lower card.`;
      return s.trim();
    }
    case 'handmaid_protect':
      return `${who(p)} ${p === me ? 'are' : 'is'} protected until ${p === me ? 'your' : 'their'} next turn.`;
    case 'prince_discard': {
      let s = `${who(t)} discarded the ${card(e['discarded'])}`;
      if (e['discarded'] === 8) return s + '.';
      if ('drew' in e) s += ` and drew the ${card(e['drew'])}`;
      else s += ' and drew a new card';
      if (e['fromBurned']) s += ' (the set-aside card)';
      return s + '.';
    }
    case 'king_swap':
      return 'received' in e
        ? `${who(p)} and ${whom(t)} swapped hands. You now hold the ${card(e['received'])}.`
        : `${who(p)} and ${whom(t)} swapped hands.`;
    case 'eliminated': {
      const reasons: Record<string, string> = {
        guessed: 'guessed by the Guard',
        baron: 'lost the Baron comparison',
        princess: 'discarded the Princess',
      };
      let s = `${who(p)} ${p === me ? 'are' : 'is'} out of the round (${reasons[String(e['reason'])] ?? e['reason']})`;
      if (e['card'] !== undefined) s += `, revealing the ${card(e['card'])}`;
      return s + '.';
    }
    case 'no_effect':
      return `${who(p)} played the ${card(e['card'])} with no effect: ${e['reason']}.`;
    case 'round_ended': {
      const ws = (e['winners'] as PlayerId[]).map(who).join(' and ');
      const why = e['reason'] === 'deck_empty' ? 'the deck ran out' : 'everyone else is out';
      const hands = Object.entries(e['hands'] as Record<string, Rank>)
        .map(([id, r]) => `${names(id)}: ${card(r)}`).join(', ');
      const tokens = Object.entries(e['tokens'] as Record<string, number>)
        .map(([id, n]) => `${names(id)} ${n}`).join(', ');
      return `Round ${e['round']} over: ${ws} ${ws.includes(' and ') || ws === 'You' ? 'win' : 'wins'} because ${why}.` +
        (hands ? ` Final hands: ${hands}.` : '') + ` Tokens: ${tokens} (first to ${e['tokensToWin']}).`;
    }
    case 'game_ended':
      return `${who(e['winner'])} ${e['winner'] === me ? 'win' : 'wins'} the game!`;
    default:
      return JSON.stringify(e);
  }
}

/** Compact listing of legal moves for a text client, grouped by card. */
export function describeMoves(moves: LegalMove[], names: Names): string {
  const byCard = new Map<Rank, LegalMove[]>();
  for (const m of moves) byCard.set(m.card, [...(byCard.get(m.card) ?? []), m]);
  const parts: string[] = [];
  for (const [rank, ms] of byCard) {
    const name = cardByRank(rank).name;
    const first = ms[0]!;
    if (first.target === undefined) {
      parts.push(name);
    } else if (first.guess !== undefined) {
      const targets = Array.from(new Set(ms.map((m) => names(m.target!))));
      parts.push(`${name} on ${targets.join('/')} guessing a card (2-8)`);
    } else {
      const targets = Array.from(new Set(ms.map((m) => names(m.target!))));
      parts.push(`${name} on ${targets.join('/')}`);
    }
  }
  return parts.join('; ') + '.';
}
