import type { Rank } from './cards.js';

export type PlayerId = string;

export interface Player {
  id: PlayerId;
  name: string;
  /** 0, 1 or 2 cards. 2 only during the owner's turn. */
  hand: Rank[];
  /** Face-up discard pile, oldest first. */
  discards: Rank[];
  /** Handmaid protection: immune to targeting until their next turn begins. */
  protected: boolean;
  /** Still in the current round. */
  alive: boolean;
  /** Rounds won. */
  tokens: number;
}

export type Phase = 'lobby' | 'playing' | 'round_over' | 'game_over';

export interface GameState {
  phase: Phase;
  players: Player[];
  /** Face-down draw pile; index 0 is the top. */
  deck: Rank[];
  /** The card set aside face-down at the start of each round. */
  burned: Rank | null;
  /** In 2-player games, three cards are set aside face-up. */
  faceUp: Rank[];
  round: number;
  /** Player whose turn it is. */
  turn: PlayerId | null;
  /** Who starts the next round (last round's winner, or a random player for round 1). */
  nextStarter: PlayerId | null;
  tokensToWin: number;
  /** Winner of the whole game once phase is game_over. */
  winner: PlayerId | null;
}

export interface Move {
  card: Rank;
  target?: PlayerId;
  /** Guard only: the rank being guessed. */
  guess?: Rank;
}

/** Per-event secret payloads keyed by player id. Merged into the event for that viewer only. */
export type Secrets = Record<PlayerId, Record<string, unknown>>;

export type EventType =
  | 'game_started'
  | 'round_started'
  | 'drew'
  | 'turn'
  | 'played'
  | 'guard_guess'
  | 'priest_look'
  | 'baron_compare'
  | 'handmaid_protect'
  | 'prince_discard'
  | 'king_swap'
  | 'eliminated'
  | 'no_effect'
  | 'round_ended'
  | 'game_ended';

export interface GameEvent {
  type: EventType;
  /** Public fields. */
  [key: string]: unknown;
  /** Private fields per player; stripped for everyone else. */
  secrets?: Secrets;
}

export interface LegalMove {
  card: Rank;
  target?: PlayerId;
  guess?: Rank;
}

export class RulesError extends Error {
  override name = 'RulesError';
}
