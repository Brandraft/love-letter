#!/usr/bin/env bash
# Interactive terminal client using curl: joins a room, streams events in the
# background, and reads moves from the keyboard.
#
#   scripts/play.sh http://host:8080/r/k7mq2x Alice
#
# At the prompt type e.g.:  guard Bob priest   |  baron Bob  |  handmaid
# Commands: /start  /bot  /next  /say hello  /state  /quit
set -euo pipefail

ROOM_URL=${1:?usage: $0 <room url> [name]}
NAME=${2:-}
[ -z "$NAME" ] && read -rp "Your name: " NAME
BASE=${ROOM_URL%/r/*}; ROOM=${ROOM_URL##*/r/}; API="$BASE/api/rooms/$ROOM"

joined=$(curl -sf -X POST "$API/join" -H 'content-type: application/json' -d "{\"name\":\"$NAME\"}") \
  || { echo "could not join: $(curl -s -X POST "$API/join" -H 'content-type: application/json' -d "{\"name\":\"$NAME\"}")"; exit 1; }
TOKEN=$(echo "$joined" | python3 -c 'import sys,json;print(json.load(sys.stdin)["token"])')
auth=(-H "authorization: Bearer $TOKEN")

curl -sN "$API/events?format=text" "${auth[@]}" | grep -v '^\s*->' &
STREAM=$!
trap 'kill $STREAM 2>/dev/null; curl -s -X POST "$API/leave" "${auth[@]}" >/dev/null; echo; echo bye' EXIT

post() { curl -s -X POST "$API/$1" "${auth[@]}" -H 'content-type: application/json' -d "${2:-{\}}" | python3 -c '
import sys,json
d=json.load(sys.stdin)
if "error" in d: print("  !", d["error"])'; }

while read -rep "> " line; do
  set -- $line
  case "${1:-}" in
    "") ;;
    /quit) exit 0 ;;
    /start) post start ;;
    /bot) post bots ;;
    /next) post next ;;
    /say) shift; post say "{\"text\":\"$*\"}" ;;
    /state) curl -s "$API" "${auth[@]}" | python3 -m json.tool ;;
    /*) echo "  ! unknown command" ;;
    *) post play "{\"card\":\"$1\",\"target\":\"${2:-}\",\"guess\":\"${3:-}\"}" ;;
  esac
done
