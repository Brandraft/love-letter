/** Card ranks in the classic 16-card edition. */
export type Rank = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;

export interface CardDef {
  rank: Rank;
  /** Stable machine id, lower-case. Used in the API. */
  id: CardId;
  /** Display name. Kept in one place so the game can be re-themed. */
  name: string;
  /** Copies in the deck. */
  count: number;
  /** Short rule text. */
  effect: string;
  /** Whether playing it requires choosing another player. */
  targets: 'none' | 'other' | 'any';
}

export type CardId =
  | 'guard'
  | 'priest'
  | 'baron'
  | 'handmaid'
  | 'prince'
  | 'king'
  | 'countess'
  | 'princess';

export const CARDS: readonly CardDef[] = [
  { rank: 1, id: 'guard', name: 'Guard', count: 5, targets: 'other',
    effect: 'Name a non-Guard card and choose another player. If they hold that card, they are out.' },
  { rank: 2, id: 'priest', name: 'Priest', count: 2, targets: 'other',
    effect: 'Look at another player\'s hand.' },
  { rank: 3, id: 'baron', name: 'Baron', count: 2, targets: 'other',
    effect: 'Compare hands with another player in private. The lower card is out.' },
  { rank: 4, id: 'handmaid', name: 'Handmaid', count: 2, targets: 'none',
    effect: 'You cannot be targeted until your next turn.' },
  { rank: 5, id: 'prince', name: 'Prince', count: 2, targets: 'any',
    effect: 'Choose any player (including yourself). They discard their hand and draw a new card.' },
  { rank: 6, id: 'king', name: 'King', count: 1, targets: 'other',
    effect: 'Trade hands with another player.' },
  { rank: 7, id: 'countess', name: 'Countess', count: 1, targets: 'none',
    effect: 'Must be played if you also hold the King or a Prince.' },
  { rank: 8, id: 'princess', name: 'Princess', count: 1, targets: 'none',
    effect: 'If you discard this card for any reason, you are out.' },
];

const BY_RANK = new Map<number, CardDef>(CARDS.map((c) => [c.rank, c]));
const BY_ID = new Map<string, CardDef>(CARDS.map((c) => [c.id, c]));
const BY_NAME = new Map<string, CardDef>(CARDS.map((c) => [c.name.toLowerCase(), c]));

export function cardByRank(rank: number): CardDef {
  const c = BY_RANK.get(rank);
  if (!c) throw new Error(`unknown card rank ${rank}`);
  return c;
}

/** Resolve a user-supplied card reference: rank number, id, or display name (case-insensitive). */
export function parseCard(input: unknown): CardDef | undefined {
  if (typeof input === 'number') return BY_RANK.get(input);
  if (typeof input !== 'string') return undefined;
  const s = input.trim().toLowerCase();
  if (/^\d+$/.test(s)) return BY_RANK.get(Number(s));
  return BY_ID.get(s) ?? BY_NAME.get(s);
}

export function buildDeck(): Rank[] {
  const deck: Rank[] = [];
  for (const c of CARDS) for (let i = 0; i < c.count; i++) deck.push(c.rank);
  return deck;
}

export const DECK_SIZE = buildDeck().length; // 16
