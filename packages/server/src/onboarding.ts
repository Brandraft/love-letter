import { CARDS } from '@love-letter/engine';
import type { Room } from './room.js';

export function cardTable(): string {
  return CARDS.map((c) => `  ${c.rank}  ${c.name.padEnd(9)} x${c.count}  ${c.effect}`).join('\n');
}

export const RULES = `
RULES (classic 16-card edition, 2 to 4 players)
  Each round, every player holds one card. On your turn you draw a second card
  and play one of the two, applying its effect. One card is set aside face down
  each round (plus three face up with 2 players).
  The round ends when only one player is left, or when the deck runs out: then
  the highest card in hand wins (ties broken by the sum of discarded cards).
  The round winner takes a token and starts the next round. First to the token
  target wins the game: 7 tokens with 2 players, 5 with 3, 4 with 4.

CARDS (rank, name, copies, effect)
${cardTable()}
`.trim();

export function homeText(base: string): string {
  return `
LOVE LETTER, playable from a browser, a terminal, or a script.

Open ${base}/ in a browser for the full interface. From a terminal:

  # Create a room
  curl -s -X POST ${base}/api/rooms
  # -> {"id":"k7mq2x","url":"${base}/r/k7mq2x", ...}

  # Then read the room's own instructions
  curl -s ${base}/r/k7mq2x

Room options (JSON body when creating, or PATCH /api/rooms/:id/options as host):
  turnSeconds        seconds per turn before a random legal card is played (0 = unlimited)
  roundPauseSeconds  pause between rounds before the next starts (0 = manual)
  tokensToWin        tokens needed to win (0 = classic: 7 with 2 players, 5 with 3, 4 with 4)
  botSeconds         how long bots take to move, so humans can follow (default 3)

${RULES}
`.trim() + '\n';
}

export function roomText(room: Room, base: string): string {
  const r = `${base}/api/rooms/${room.id}`;
  const g = room.game;
  const phase = !g || g.phase === 'lobby' ? 'waiting in the lobby' : g.phase === 'playing'
    ? `round ${g.round} in progress, ${room.nameOf(g.turn!)} to move`
    : g.phase === 'round_over' ? `round ${g.round} just ended` : 'game over';
  const players = room.seats.length
    ? room.seats.map((s) => `${s.name}${s.bot ? ' (bot)' : ''}${s.id === room.hostId ? ' (host)' : ''}`).join(', ')
    : 'nobody yet';
  return `
LOVE LETTER, room ${room.id}
Status:  ${phase}
Players: ${players}
Browser: ${base}/r/${room.id}

HOW TO PLAY FROM A TERMINAL (or any HTTP client)

1. Join. Pick a display name. You get a token that identifies your seat.

     curl -s -X POST ${r}/join -H 'content-type: application/json' -d '{"name":"Alice"}'
     # -> {"token":"...","playerId":"...","name":"Alice"}
     export TOKEN=...   # keep it; it is your seat

   The first human to join is the host and can start the game or add bots:

     curl -s -X POST ${r}/bots  -H "authorization: Bearer $TOKEN"
     curl -s -X POST ${r}/start -H "authorization: Bearer $TOKEN"

2. Watch. Stream everything that happens, as plain English, one line per event.
   Keep this running in a second terminal (or in the background). Lines marked
   with "Your turn" tell you your hand and your options.

     curl -sN ${r}/events -H "authorization: Bearer $TOKEN"

   The same endpoint speaks JSON: add "?format=json" to get the backlog and
   return at once, "&since=<seq>" to get only newer events, and "&wait=20" to
   block up to 20 seconds for something new (handy for scripts). Send
   "Accept: text/event-stream" for Server-Sent Events. Without a token you
   see the spectator view.

3. Play. On your turn, post the card to play, plus a target and (for the Guard)
   a guess when the card needs them. Cards and targets can be given by name or
   number; names are case-insensitive.

     curl -s -X POST ${r}/play -H "authorization: Bearer $TOKEN" \\
       -H 'content-type: application/json' \\
       -d '{"card":"guard","target":"Bob","guess":"priest"}'

   Illegal moves are rejected with a sentence explaining why, nothing changes,
   and you can try again. Everything else:

     curl -s ${r} -H "authorization: Bearer $TOKEN"            # full state as JSON (your hand, legal moves)
     curl -s -X POST ${r}/say -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -d '{"text":"gg"}'
     curl -s -X POST ${r}/next -H "authorization: Bearer $TOKEN"   # start the next round early
     curl -s -X POST ${r}/leave -H "authorization: Bearer $TOKEN"

${RULES}
`.trim() + '\n';
}
