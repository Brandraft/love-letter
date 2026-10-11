#!/usr/bin/env bash
# A minimal Love Letter player that uses nothing but curl and python3.
# It joins a room, waits for its turn, and plays a random legal move.
#
#   scripts/random-agent.sh http://host:8080/r/k7mq2x "Robo"
#
# This exists to prove the protocol is enough to play with, and as a template
# for smarter agents: replace the "pick" function with your own strategy.
set -euo pipefail

ROOM_URL=${1:?usage: $0 <room url> [name]}
NAME=${2:-Random-$RANDOM}
BASE=${ROOM_URL%/r/*}
ROOM=${ROOM_URL##*/r/}
API="$BASE/api/rooms/$ROOM"

json() { python3 -c "import sys,json; d=json.load(sys.stdin); print($1)"; }

joined=$(curl -sf -X POST "$API/join" -H 'content-type: application/json' -d "{\"name\":\"$NAME\"}")
TOKEN=$(echo "$joined" | json 'd["token"]')
echo "joined $ROOM as $NAME"

pick() { # stdin: room view JSON; stdout: a move as JSON, or empty if not our turn
  python3 -c '
import sys, json, random
d = json.load(sys.stdin)
g = d.get("game")
if not g or g.get("phase") != "playing" or g.get("turn") != d["you"]["id"]:
    sys.exit(0)
print(json.dumps(random.choice(g["legal"])))'
}

since=0
while :; do
  # Block until something new happens (long-poll), print it, then look at the state.
  curl -sf "$API/events?format=json&since=$since&wait=20" -H "authorization: Bearer $TOKEN" \
    | python3 -c 'import sys,json
for e in json.load(sys.stdin)["events"]: print("['"$NAME"']", "[%d]" % e["seq"], e["text"])' || true
  view=$(curl -sf "$API" -H "authorization: Bearer $TOKEN")
  since=$(echo "$view" | json 'd["seq"]')
  phase=$(echo "$view" | json 'd["game"]["phase"] if d.get("game") else "lobby"')
  if [ "$phase" = game_over ]; then echo "[$NAME] game over"; exit 0; fi
  if [ "$phase" = lobby ]; then
    # If we are host and someone else is here, start the game after a short grace period.
    if [ "$(echo "$view" | json 'd["you"]["host"] and len(d["players"]) >= 2')" = True ]; then
      sleep "${START_DELAY:-5}"; echo "[$NAME] starting the game"
      curl -s -X POST "$API/start" -H "authorization: Bearer $TOKEN" >/dev/null
    fi
  fi
  move=$(echo "$view" | pick)
  if [ -n "$move" ]; then
    echo "[$NAME] playing $move"
    curl -s -X POST "$API/play" -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -d "$move" >/dev/null
  fi
  sleep 1
done
