# Love Letter

The card game Love Letter, playable three ways from the same room:

- **in a browser**, with a proper table, cards and animations;
- **from a terminal**, with nothing but `curl`;
- **by a script or an AI agent**, over a small JSON API with a live event stream.

Create a room, share the link. Humans open it in a browser. Anything else
fetches it with `curl` and gets the rules and the three commands it needs to
join, watch and play. Every player, human or not, sees exactly the same
information a player at the table would.

```sh
curl -s -X POST https://example.org/api/rooms          # make a room
curl -s https://example.org/r/k7mq2x                   # read the room's instructions
```

## How it works

The game is API-first. The web client is just another consumer of the same
endpoints and the same Server-Sent Events stream that `curl` uses.

```
POST /api/rooms                      create a room            -> {id, url}
GET  /r/:id                          browser: the app · curl: plain-text instructions
POST /api/rooms/:id/join   {name}    take a seat              -> {token}
GET  /api/rooms/:id                  state as you may see it (your hand, your legal moves)
GET  /api/rooms/:id/events           live stream: SSE, plain English lines, or JSON (+ long-poll)
POST /api/rooms/:id/play   {card, target?, guess?}            illegal moves are explained, not punished
POST /api/rooms/:id/start | next | bots | say | leave | kick   lobby and table controls
PATCH /api/rooms/:id/options         {tokensToWin, botSeconds, turnSeconds, roundPauseSeconds}
GET  /api/rooms/:id/qr.svg           the invite link as a QR code
```

Identity is a per-seat bearer token handed out at join time. There are no
accounts. Every event in a room is appended to one log with a sequence number;
private details (your hand, what the Priest showed you) are stored as
per-player secrets on the event and filtered on the way out, so one log serves
players, spectators and replays.

Rooms can include bots. A human who leaves mid-game is replaced by a bot so the
table keeps going. Optional turn timers play a random legal card for stalled
players rather than eliminating them. Room options: `tokensToWin` (0 = classic
7/5/4 by player count), `botSeconds` (how long bots take to move, default 3,
so people can follow the table), `turnSeconds`, `roundPauseSeconds`.

## Playing from a terminal

```sh
ROOM=https://example.org/r/k7mq2x
API=${ROOM/\/r\//\/api\/rooms\/}

TOKEN=$(curl -s -X POST $API/join -H 'content-type: application/json' -d '{"name":"Alice"}' | jq -r .token)

# in one terminal: watch
curl -sN $API/events -H "authorization: Bearer $TOKEN"

# in another: play
curl -s -X POST $API/play -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -d '{"card":"guard","target":"Bob","guess":"priest"}'
```

`scripts/play.sh <room url> <name>` wraps this into a small interactive
client, and `scripts/random-agent.sh <room url> <name>` is a complete (if
clueless) player in 40 lines of shell, meant as a template for smarter agents.

## Rules

Classic 16-card edition, 2 to 4 players. Guard ×5, Priest ×2, Baron ×2,
Handmaid ×2, Prince ×2, King, Countess, Princess. First to 7/5/4 tokens
(2/3/4 players) wins by default; the host can set any target in the lobby. Card names live in one table in
`packages/engine/src/cards.ts` so the game can be re-themed in one place.

## Development

```sh
pnpm install
pnpm test           # engine rules + HTTP API tests
pnpm build
pnpm start          # http://localhost:8080
pnpm --filter @love-letter/web test:ui   # browser walkthrough (needs Chromium: npx playwright install chromium)
```

In the browser, digits pick a card, a target and a guess; Enter plays, Escape
cancels. The top bar switches between the light and dark wall.

Packages: `engine` (pure rules, no I/O), `server` (Hono + SQLite via
`node:sqlite`), `web` (React + Vite). Node 24 or newer.

For a dev loop run `pnpm --filter @love-letter/server dev` and
`pnpm --filter @love-letter/web dev` (Vite proxies `/api` to port 8080).

See [deploy/README.md](deploy/README.md) for running it as a service.

## Design

The visual system (why the cards are the paintings and the interface is the
gallery wall, the palette, the type, the motion) is documented at `/design/` on
a running server, with three studies of alternatives that were considered and
rejected under `/design/art/`, `/design/retheme/` and `/design/free-art/`.

## Art and type

Card illustrations are details from the Codex Manesse (Zürich, c. 1300–1340),
a manuscript of courtly love poetry held by Heidelberg University Library,
public domain, via Wikimedia Commons:

| Card     | Miniature                                   |
| -------- | ------------------------------------------- |
| Guard    | Kristan von Luppin (fol. 226v)              |
| Priest   | Konrad von Würzburg (fol. 383r)             |
| Baron    | Walther von Klingen (fol. 52r)              |
| Handmaid | Die Winsbekin (fol. 217r), the attendant    |
| Prince   | Der Winsbeke (fol. 213r)                    |
| King     | Kaiser Heinrich VI (fol. 6r)                |
| Countess | Bernger von Horheim (fol. 178r), the lady   |
| Princess | Die Winsbekin (fol. 217r), the seated lady  |

Type is Alegreya and Alegreya Sans by Juan Pablo del Peral, Huerta Tipográfica,
SIL Open Font License 1.1, self-hosted under `packages/web/public/fonts`.

## License

MIT for the code. Love Letter was designed by Seiji Kanai; this is an
unofficial fan implementation of the rules and uses no artwork from the
published game.
