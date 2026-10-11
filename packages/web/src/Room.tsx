import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CARDS, cardByRank, type LegalMove, type Rank } from '@love-letter/engine';
import { api, ApiError, getName, getToken, setName, setToken, subscribe, type RoomView, type ViewEvent } from './api';
import { ThemeToggle } from './theme';
import { Card, CardBack } from './Card';

type Act = (fn: () => Promise<unknown>) => void;

export function Room({ id, navigate }: { id: string; navigate: (to: string) => void }) {
  const [token, setTok] = useState<string | null>(() => getToken(id));
  const [view, setView] = useState<RoomView | null>(null);
  const [events, setEvents] = useState<ViewEvent[]>([]);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);
  const seqRef = useRef(0);
  const gen = useRef(0);

  const refresh = useCallback(async () => {
    const g = gen.current;
    try {
      const v = await api.view(id, token);
      if (g !== gen.current) return;
      setView(v);
      if (token && !v.you) { setToken(id, null); setTok(null); }
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) setNotFound(true);
    }
  }, [id, token]);

  useEffect(() => {
    gen.current += 1;
    let closed = false;
    let unsub = () => {};
    (async () => {
      try {
        const v = await api.view(id, token);
        if (closed) return;
        setView(v);
        if (token && !v.you) { setToken(id, null); setTok(null); return; }
        const backlog = await api.events(id, token);
        if (closed) return;
        setEvents(backlog.events);
        seqRef.current = backlog.seq;
        let pending = false;
        unsub = subscribe(id, token, backlog.seq, (e) => {
          if (e.seq <= seqRef.current) return;
          seqRef.current = e.seq;
          setEvents((prev) => [...prev.slice(-600), e]);
          if (!pending) {
            pending = true;
            setTimeout(() => { pending = false; if (!closed) void refresh(); }, 30);
          }
        }, setConnected);
      } catch (e) {
        if (e instanceof ApiError && e.status === 404) setNotFound(true);
      }
    })();
    return () => { closed = true; unsub(); };
  }, [id, token, refresh]);

  const fail = (e: unknown) => {
    setError(e instanceof ApiError ? e.message : String(e));
    setTimeout(() => setError(null), 4000);
  };
  const act: Act = (fn) => { fn().then(() => refresh()).catch(fail); };

  if (notFound) {
    return (
      <main className="center">
        <p className="label">Room {id}</p>
        <h1>No such room</h1>
        <p className="muted">It may have expired. Rooms are kept for two days after the last move.</p>
        <button className="btn" onClick={() => navigate('/')}>Home</button>
      </main>
    );
  }
  if (!view) return <main className="center"><p className="faint">Loading…</p></main>;

  const g = view.game;
  const inGame = !!g && g.phase !== 'lobby';
  const name = (pid: unknown) => view.players.find((p) => p.id === pid)?.name ?? String(pid);

  return (
    <div className="room">
      <header className="topbar">
        <a href="/" onClick={(e) => { e.preventDefault(); navigate('/'); }} className="brand">Love Letter</a>
        <span className="meta">
          <b>{id}</b>
          {inGame && g && <> · Round {g.round} · first to {g.tokensToWin}{g.phase === 'playing' && <> · {g.deckSize} in the deck</>}</>}
          <span className={`conn ${connected ? '' : 'off'}`} title={connected ? 'live' : 'reconnecting'} />
        </span>
        {inGame && g && (
          <span className="scores">
            {g.players.map((p) => (
              <span key={p.id} className={g.turn === p.id && g.phase === 'playing' ? 'turn' : ''}>
                {p.id === view.you?.id ? 'You' : p.name}<b key={p.tokens} className={p.tokens > 0 ? 'bump' : ''}>{p.tokens}</b>
              </span>
            ))}
          </span>
        )}
        <span className="tools" style={{ marginLeft: inGame ? 0 : 'auto' }}>
          <ThemeToggle />
          {view.you && (
            <button className="link" onClick={() => act(async () => { await api.leave(id, token!); setToken(id, null); setTok(null); })}>Leave</button>
          )}
        </span>
      </header>

      {error && <div className="toast">{error}</div>}

      {!view.you ? (
        <JoinPanel id={id} view={view} onJoined={(t) => { setToken(id, t); setTok(t); }} />
      ) : !inGame ? (
        <Lobby id={id} view={view} token={token!} act={act} />
      ) : (
        <Table id={id} view={view} token={token!} act={act} events={events} />
      )}

    </div>
  );
}

function JoinPanel({ id, view, onJoined }: { id: string; view: RoomView; onJoined: (t: string) => void }) {
  const [nm, setNm] = useState(getName());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const started = !!view.game && view.game.phase !== 'lobby';
  async function join(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError('');
    try {
      const r = await api.join(id, nm);
      setName(r.name);
      onJoined(r.token);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'could not join');
    } finally { setBusy(false); }
  }
  return (
    <main className="center">
      <p className="label">Room {id}</p>
      <h1>{started ? 'A game is in progress' : 'Take a seat'}</h1>
      <p className="muted">
        {view.players.length ? `At the table: ${view.players.map((p) => p.name).join(', ')}.` : 'Nobody here yet. You will be the host.'}
      </p>
      {!started && (
        <form onSubmit={join}>
          <input autoFocus value={nm} onChange={(e) => setNm(e.target.value)} placeholder="Your name" maxLength={24} aria-label="Your name" />
          <button className="btn" disabled={busy || !nm.trim()}>Join</button>
        </form>
      )}
      {error && <p className="error">{error}</p>}
      {started && view.game && (
        <div className="spectator">
          {view.game.players.map((p) => (
            <div key={p.id} className={`seat ${!p.alive ? 'out' : ''}`}>
              <div className="hand-back">{p.handSize > 0 ? <CardBack size="sm" /> : null}</div>
              <div className="nm">{p.name} <small>{p.tokens} tokens</small></div>
              <div className="st">{!p.alive ? 'Out' : p.protected ? 'Protected' : ''}</div>
              <Hist discards={p.discards} />
            </div>
          ))}
        </div>
      )}
    </main>
  );
}

function Lobby({ id, view, token, act }: { id: string; view: RoomView; token: string; act: Act }) {
  const link = `${window.location.origin}/r/${id}`;
  const [copied, setCopied] = useState(false);
  const linkRef = useRef<HTMLInputElement>(null);
  const host = view.you!.host;
  const copy = async () => {
    let ok = false;
    try { if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(link); ok = true; } } catch { /* fall through */ }
    if (!ok && linkRef.current) {
      linkRef.current.focus(); linkRef.current.select(); linkRef.current.setSelectionRange(0, link.length);
      try { ok = document.execCommand('copy'); } catch { ok = false; }
    }
    setCopied(ok);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <main className="lobby">
      <p className="label">Lobby</p>
      <h1 style={{ marginTop: 10 }}>Waiting for players</h1>
      <div className="share">
        <div>
          <div className="invite">
            <input ref={linkRef} readOnly value={link} onFocus={(e) => e.target.select()} aria-label="invite link" />
            <button className="link" onClick={copy}>{copied ? 'Copied' : 'Copy'}</button>
          </div>
          <p className="muted small">Share the link, or point a phone at the code. Scripts and agents can fetch the link with curl for instructions.</p>
        </div>
        <img className="qr" src={`/api/rooms/${id}/qr.svg`} alt="QR code of the invite link" width={96} height={96} />
      </div>

      <ul className="players">
        {view.players.map((p) => (
          <li key={p.id}>
            <span className="nm">{p.name}</span>
            <span className="who">{p.host ? 'Host' : p.bot ? 'Bot' : ''}</span>
            <span className="spacer" />
            {host && p.id !== view.you!.id && <button className="link" onClick={() => act(() => api.kick(id, token, p.id))}>remove</button>}
          </li>
        ))}
        {Array.from({ length: Math.max(0, 2 - view.players.length) }).map((_, i) => (
          <li key={`e${i}`} className="empty"><span className="nm">Empty seat</span></li>
        ))}
      </ul>

      {host ? (
        <div className="controls">
          <button className="btn btn-sec" disabled={view.players.length >= 4} onClick={() => act(() => api.addBot(id, token))}>Add a bot</button>
          <label>
            First to
            <select value={view.options.tokensToWin} onChange={(e) => act(() => api.options(id, token, { tokensToWin: Number(e.target.value) }))}>
              <option value={0}>classic ({classicTokens(view.players.length)})</option>
              {[1, 2, 3, 4, 5, 7, 10].map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
          </label>
          <label>
            Pace
            <select value={view.options.botSeconds} onChange={(e) => act(() => api.options(id, token, { botSeconds: Number(e.target.value) }))}>
              <option value={1}>quick</option>
              <option value={3}>normal</option>
              <option value={6}>slow</option>
            </select>
          </label>
          <label>
            Turn timer
            <select value={view.options.turnSeconds} onChange={(e) => act(() => api.options(id, token, { turnSeconds: Number(e.target.value) }))}>
              <option value={0}>none</option>
              <option value={30}>30 s</option>
              <option value={60}>60 s</option>
              <option value={120}>2 min</option>
            </select>
          </label>
          <button className="btn" disabled={view.players.length < 2} onClick={() => act(() => api.start(id, token))}>Start game</button>
        </div>
      ) : (
        <p className="muted">Waiting for {name(view, view.hostId)} to start the game.</p>
      )}
    </main>
  );
}

function classicTokens(players: number): number {
  return players <= 2 ? 7 : players === 3 ? 5 : 4;
}

function name(view: RoomView, pid: unknown): string {
  return view.players.find((p) => p.id === pid)?.name ?? 'the host';
}

function Hist({ discards, known }: { discards: Rank[]; known?: Rank }) {
  return (
    <div className="hist" title={discards.map((r) => cardByRank(r).name).join(', ') || 'no discards yet'}>
      {discards.map((r, i) => (i === discards.length - 1 ? <b key={i}>{r}</b> : <span key={i}>{r}</span>))}
      {known !== undefined && <span className="known" title={`You know this player holds the ${cardByRank(known).name}`}>·{known}</span>}
    </div>
  );
}

/** Underline the played card and set the guessed card in italic accent. */
function emphasize(text: string): React.ReactNode {
  const names = [...CARDS].sort((a, b) => b.name.length - a.name.length).map((c) => c.name).join('|');
  const re = new RegExp(`(guessing|the) (${names})\\b`, 'g');
  const out: React.ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(re)) {
    const i = m.index ?? 0;
    out.push(text.slice(last, i));
    out.push(m[1] === 'guessing'
      ? <span key={i}>guessing <em>{m[2]}</em></span>
      : <span key={i}>the <u>{m[2]}</u></span>);
    last = i + m[0].length;
  }
  out.push(text.slice(last));
  return out;
}

function useNow(active: boolean) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, [active]);
  return now;
}

/** The last action on the table: the played card and what followed, until the next draw. */
type ActionCard = { rank: Rank; who?: string };
type Action = { kind: 'action'; seq: number; played: ViewEvent; cards: ActionCard[]; sub: string; mine: boolean; end: number };
type Plain = { kind: 'event'; seq: number; e: ViewEvent };
type LedgerItem = Action | Plain;

const FOLLOW_STOP = new Set(['drew', 'turn', 'played', 'round_started']);

/** Read one played card and the events it caused, starting at index `start`. */
function readAction(events: ViewEvent[], start: number, me: string): Action {
  const played = events[start]!;
  const follow: ViewEvent[] = [];
  let i = start + 1;
  for (; i < events.length; i++) {
    const e = events[i]!;
    if (FOLLOW_STOP.has(e.type)) break;
    if (e.type === 'chat') continue;
    follow.push(e);
  }
  const cards: ActionCard[] = [{ rank: played['card'] as Rank }];
  for (const e of follow) {
    if (e.type === 'guard_guess') cards.push({ rank: e['guess'] as Rank, who: 'guess' });
    if (e.type === 'eliminated' && typeof e['card'] === 'number' && !cards.some((c) => c.rank === e['card'])) cards.push({ rank: e['card'] as Rank, who: 'revealed' });
    if (e.type === 'priest_look' && typeof e['card'] === 'number') cards.push({ rank: e['card'] as Rank, who: 'seen' });
    if (e.type === 'baron_compare' && typeof e['card'] === 'number') cards.push({ rank: e['card'] as Rank, who: 'seen' });
    if (e.type === 'king_swap' && typeof e['received'] === 'number') cards.push({ rank: e['received'] as Rank, who: 'received' });
    if (e.type === 'prince_discard' && typeof e['discarded'] === 'number') cards.push({ rank: e['discarded'] as Rank, who: 'discarded' });
  }
  const sub = follow.filter((e) => e.type !== 'round_ended' && e.type !== 'game_ended').map((e) => e.text).join(' ');
  return { kind: 'action', seq: played.seq, played, cards: cards.slice(0, 3), sub, mine: played['player'] === me, end: i };
}

function lastAction(events: ViewEvent[], me: string): Action | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const t = events[i]!.type;
    if (t === 'round_started' || t === 'game_started') return null;
    if (t === 'played') return readAction(events, i, me);
  }
  return null;
}

const LEDGER_SKIP = new Set(['room_created', 'turn', 'options_changed', 'host_changed']);

/** The whole history as ledger rows: played cards become action rows with their consequences folded in. */
function ledgerItems(events: ViewEvent[], me: string): LedgerItem[] {
  const out: LedgerItem[] = [];
  const consumed = new Set<number>();
  for (let i = 0; i < events.length; i++) {
    const e = events[i]!;
    if (consumed.has(i) || LEDGER_SKIP.has(e.type)) continue;
    if (e.type === 'drew' && !('card' in e)) continue;
    if (e.type === 'played') {
      const a = readAction(events, i, me);
      for (let j = i + 1; j < a.end; j++) {
        const t = events[j]!.type;
        if (t !== 'chat' && t !== 'round_ended' && t !== 'game_ended') consumed.add(j);
      }
      out.push(a);
      continue;
    }
    out.push({ kind: 'event', seq: e.seq, e });
  }
  return out;
}

function Table({ id, view, token, act, events }: {
  id: string; view: RoomView; token: string; act: Act; events: ViewEvent[];
}) {
  const g = view.game!;
  const meId = view.you!.id;
  const me = g.players.find((p) => p.id === meId)!;
  const myTurn = g.turn === meId && g.phase === 'playing';
  const legal = g.legal ?? [];
  const [card, setCard] = useState<Rank | null>(null);
  const [target, setTarget] = useState<string | null>(null);
  const [guess, setGuess] = useState<Rank | null>(null);
  const [leaving, setLeaving] = useState<Rank | null>(null);
  const now = useNow(!!view.turnDeadline || !!view.nextRoundAt);
  const names = (pid: unknown) => (pid === meId ? 'you' : g.players.find((p) => p.id === pid)?.name ?? String(pid));

  useEffect(() => { setCard(null); setTarget(null); setGuess(null); }, [g.turn, g.round]);
  useEffect(() => { setLeaving(null); }, [me.hand?.length, g.turn]);

  const movesFor = (r: Rank) => legal.filter((m) => m.card === r);
  const needsTarget = card !== null && movesFor(card).some((m) => m.target !== undefined);
  const needsGuess = card === 1 && needsTarget;
  const targetIds = card !== null ? Array.from(new Set(movesFor(card).map((m) => m.target).filter(Boolean))) as string[] : [];
  const noEffect = card !== null && cardByRank(card).targets !== 'none' && !needsTarget;
  const ready = card !== null && (!needsTarget || target !== null) && (!needsGuess || guess !== null);

  // Cards not accounted for from my point of view: deck, other hands and the set-aside card.
  const unseen = useMemo(() => {
    const counts = new Map<Rank, number>(CARDS.map((c) => [c.rank, c.count]));
    const seen: Rank[] = [...g.faceUp, ...(me.hand ?? [])];
    for (const p of g.players) seen.push(...p.discards);
    for (const r of seen) counts.set(r, (counts.get(r) ?? 0) - 1);
    return counts;
  }, [g, me.hand]);

  // What I privately know about other hands this round.
  const intel = useMemo(() => {
    const out = new Map<string, Rank>();
    for (const e of events) {
      const p = String(e['player']); const t = String(e['target']);
      if (e.type === 'round_started') out.clear();
      if (e.type === 'priest_look' && p === meId && typeof e['card'] === 'number') out.set(t, e['card'] as Rank);
      if (e.type === 'baron_compare' && typeof e['card'] === 'number') out.set(p === meId ? t : p, e['card'] as Rank);
      if (e.type === 'king_swap' && typeof e['received'] === 'number') out.delete(p === meId ? t : p);
      if (e.type === 'played' && p !== meId && out.get(p) === e['card']) out.delete(p);
      if (e.type === 'prince_discard') out.delete(t);
      if (e.type === 'eliminated') out.delete(p);
    }
    return out;
  }, [events, meId]);

  const submit = () => {
    if (!ready) return;
    const m: LegalMove = { card: card! };
    if (needsTarget) m.target = target!;
    if (needsGuess) m.guess = guess!;
    setLeaving(card);
    setCard(null); setTarget(null); setGuess(null);
    act(() => api.play(id, token, m));
  };
  const reset = () => { setCard(null); setTarget(null); setGuess(null); };

  // Keyboard: digits pick a card, then a target, then a guess; Enter plays, Escape cancels.
  useEffect(() => {
    if (!myTurn) return;
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT')) return;
      if (e.key === 'Escape') { reset(); return; }
      if (e.key === 'Enter') { if (ready) { e.preventDefault(); submit(); } return; }
      if (!/^[1-9]$/.test(e.key)) return;
      const n = Number(e.key);
      if (card === null) {
        const r = n as Rank;
        if ((me.hand ?? []).includes(r) && movesFor(r).length > 0) setCard(r);
      } else if (needsTarget && !target) {
        const t = targetIds[n - 1];
        if (t) setTarget(t);
      } else if (needsGuess && !guess) {
        const r = n as Rank;
        if (r >= 2 && r <= 8 && movesFor(card).some((m) => m.guess === r)) setGuess(r);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const pickCard = (r: Rank) => {
    if (!myTurn) return;
    if (movesFor(r).length === 0) {
      if (me.hand?.includes(7) && r !== 7) {
        const other = me.hand.find((h) => h !== 7)!;
        act(() => Promise.reject(new ApiError(422, `You hold the Countess with the ${cardByRank(other).name}, so you must play the Countess.`)));
      }
      return;
    }
    setCard(r); setTarget(null); setGuess(null);
    const ts = Array.from(new Set(movesFor(r).map((m) => m.target).filter(Boolean))) as string[];
    if (ts.length === 1 && r !== 5) setTarget(ts[0]!);
  };

  const opponents = g.players.filter((p) => p.id !== meId);
  const secondsLeft = view.turnDeadline ? Math.max(0, Math.ceil((view.turnDeadline - now) / 1000)) : null;
  const nextIn = view.nextRoundAt ? Math.max(0, Math.ceil((view.nextRoundAt - now) / 1000)) : null;
  const action = useMemo(() => lastAction(events, meId), [events, meId]);
  const lastRound = [...events].reverse().find((e) => e.type === 'round_ended');
  const roundStart = [...events].reverse().find((e) => e.type === 'round_started');

  return (
    <main className="table">
      <div className="seats">
        {opponents.map((p) => {
          const targetable = card !== null && targetIds.includes(p.id);
          const isTurn = g.turn === p.id && g.phase === 'playing';
          const seat = view.players.find((x) => x.id === p.id);
          const known = intel.get(p.id);
          const status = !p.alive ? `Out${p.discards.length ? ` · held the ${cardByRank(p.discards[p.discards.length - 1]!).name}` : ''}`
            : isTurn ? `Thinking${secondsLeft !== null ? ` · ${secondsLeft} s` : '…'}`
            : p.protected ? 'Protected this turn'
            : known !== undefined ? `Holds the ${cardByRank(known).name}` : '';
          return (
            <div
              key={p.id}
              className={['seat', !p.alive ? 'out' : '', targetable ? 'targetable' : '', target === p.id ? 'target' : ''].join(' ')}
              onClick={targetable ? () => setTarget(p.id) : undefined}
            >
              <div className="hand-back">{p.handSize > 0 ? <CardBack size="sm" /> : <div style={{ width: 56 }} />}</div>
              <div className="nm">{p.name}{(seat?.bot || seat?.gone) && <small>Bot</small>}</div>
              <div className={`st ${isTurn ? 'turn' : ''}`}>{status}</div>
              <Hist discards={p.discards} />
            </div>
          );
        })}
      </div>

      <div className={`stage ${action ? '' : 'idle'}`}>
        <div className="cards">
          {action ? action.cards.map((c, i) => (
            <span key={`${action.played.seq}-${i}`} style={{ display: 'contents' }}>
              {i > 0 && <span className="arrow">→</span>}
              <Card rank={c.rank} size="md" className={i > 0 ? 'second flip' : 'deal'} title={c.who ? `${c.who}: ${cardByRank(c.rank).name}` : undefined} />
            </span>
          )) : (g.deckSize > 0 ? <CardBack size="md" /> : <div style={{ width: 104 }} />)}
        </div>
        <div className="narr" role="status" aria-live="polite">
          {action ? (
            <>
              <div className="big">{emphasize(action.played.text)}</div>
              {action.sub && <div className="sub">{action.sub}</div>}
            </>
          ) : (
            <div className="big">{roundStart ? roundStart.text.replace(/ Your hand:.*$/, '') : `Round ${g.round}.`}</div>
          )}
          {g.phase === 'playing' && <div className="deck">{g.deckSize} card{g.deckSize === 1 ? '' : 's'} left in the deck{g.faceUp.length ? ` · set aside: ${g.faceUp.map((r) => cardByRank(r).name).join(', ')}` : ''}</div>}
        </div>
      </div>

      <div className={`me ${(me.hand ?? []).length === 0 ? 'empty' : ''}`}>
        <div>
          <div className="mine">
            <span className="you">You</span>
            {myTurn && <span className="turn">Your turn{secondsLeft !== null ? ` · ${secondsLeft} s` : ''}</span>}
            {!me.alive && <span>Out this round</span>}
            {me.alive && me.protected && !myTurn && <span>Protected</span>}
            <Hist discards={me.discards} />
          </div>
          <div className="hand">
            {(me.hand ?? []).map((r, i) => (
              <Card
                key={`${g.round}-${i}`} rank={r} size="lg"
                className={`deal ${leaving === r && i === (me.hand ?? []).indexOf(r) ? 'leave' : ''}`}
                selected={card === r}
                disabled={!myTurn}
                dim={myTurn && movesFor(r).length === 0}
                onClick={() => pickCard(r)}
              />
            ))}
            {(me.hand ?? []).length === 0 && <span className="hand-empty">{me.alive ? 'No cards' : 'Out of this round'}</span>}
          </div>
        </div>

        <div className="cmd">
          {!myTurn ? (
            <div className="wait">
              {g.phase === 'playing' ? <>Waiting for <b className="serif">{names(g.turn)}</b>…</> : 'Round over.'}
            </div>
          ) : card === null ? (
            <>
              <div className="sent"><u className="todo">Choose a card</u> to play.</div>
              <div className="hint">
                {me.hand?.includes(7) && (me.hand.includes(5) || me.hand.includes(6)) ? 'You hold the Countess with a royal, so she must be played.' : 'Tap a card in your hand, or press its number.'}
              </div>
            </>
          ) : (
            <>
              <div className="sent">
                Play the <u className="pick" onClick={reset}>{cardByRank(card).name}</u>
                {needsTarget && <> on {target ? <u className="pick" onClick={() => setTarget(null)}>{target === meId ? 'yourself' : names(target)}</u> : <u className="todo">someone</u>}</>}
                {needsGuess && target && <>, guessing {guess ? <u className="pick" onClick={() => setGuess(null)}>{cardByRank(guess).name}</u> : <u className="todo">a card</u>}</>}
                {noEffect && <> <span className="muted" style={{ fontWeight: 400, fontSize: 16 }}>(nobody can be targeted, so it has no effect)</span></>}.
              </div>
              {needsTarget && !target && (
                <div className="opts">
                  {targetIds.map((t) => (
                    <button key={t} onClick={() => setTarget(t)}><kbd>{targetIds.indexOf(t) + 1}</kbd>{t === meId ? 'yourself' : names(t)}</button>
                  ))}
                </div>
              )}
              {needsGuess && target && !guess && (
                <div className="opts">
                  {CARDS.filter((c) => c.rank !== 1).map((c) => {
                    const left = unseen.get(c.rank) ?? 0;
                    // When nothing can hit (only Guards remain), every guess stays available.
                    const anyLeft = CARDS.some((d) => d.rank !== 1 && (unseen.get(d.rank) ?? 0) > 0);
                    return (
                      <button key={c.rank} onClick={() => setGuess(c.rank)} disabled={anyLeft && left <= 0} title={`${left} unaccounted for`}>
                        <kbd>{c.rank}</kbd>{c.name}<small>{left}</small>
                      </button>
                    );
                  })}
                </div>
              )}
              <div className="act">
                <button className="btn btn-cta" disabled={!ready} onClick={submit}>Play the {cardByRank(card).name}</button>
                <button className="link" onClick={reset}>Cancel</button>
              </div>
            </>
          )}
        </div>
      </div>

      <Ledger id={id} token={token} events={events} you={meId} round={g.round} />

      {g.phase === 'round_over' && lastRound && (
        <div className="overlay">
          <div className="sheet">
            <p className="label">Round {g.round} over</p>
            <h1 style={{ marginTop: 10 }}>
              {(lastRound['winners'] as string[]).map((w) => (w === meId ? 'You' : names(w))).join(' and ')}
              {' '}{(lastRound['winners'] as string[]).includes(meId) || (lastRound['winners'] as string[]).length > 1 ? 'win' : 'wins'} the round
            </h1>
            <p className="muted" style={{ marginTop: 10 }}>{lastRound['reason'] === 'deck_empty' ? 'The deck ran out, so the highest card wins.' : 'Everyone else was knocked out.'}</p>
            <div className="reveal">
              {Object.entries(lastRound['hands'] as Record<string, Rank>).map(([pid, r]) => (
                <div key={pid}><Card rank={r} size="md" /><b>{pid === meId ? 'You' : names(pid)}</b></div>
              ))}
            </div>
            <div className="standings">
              {g.players.map((p) => <span key={p.id}>{p.id === meId ? 'You' : p.name}<b>{p.tokens}</b></span>)}
              <span className="faint">first to {g.tokensToWin}</span>
            </div>
            <div className="act">
              <button className="btn" onClick={() => act(() => api.next(id, token))}>Next round{nextIn !== null ? ` · ${nextIn} s` : ''}</button>
            </div>
          </div>
        </div>
      )}

      {g.phase === 'game_over' && (
        <div className="overlay">
          <div className="sheet">
            <p className="label">Game over</p>
            <h1 style={{ marginTop: 10 }}>{g.winner === meId ? 'You win' : `${names(g.winner)} wins`}</h1>
            <div className="standings" style={{ marginTop: 18 }}>
              {g.players.map((p) => <span key={p.id}>{p.id === meId ? 'You' : p.name}<b>{p.tokens}</b></span>)}
            </div>
            <div className="act">
              {view.you!.host
                ? <button className="btn" onClick={() => act(() => api.start(id, token))}>Play again</button>
                : <span className="muted">Waiting for the host to start a new game.</span>}
            </div>
          </div>
        </div>
      )}
    </main>
  );
}

/** The game's history as an expandable ledger, grouped by round, with chat at the end. */
function Ledger({ id, token, events, you, round }: { id: string; token: string; events: ViewEvent[]; you: string; round: number }) {
  const [open, setOpen] = useState(() => localStorage.getItem('love-letter:ledger') === 'open');
  const [text, setText] = useState('');
  const listRef = useRef<HTMLDivElement>(null);
  const lastSeen = useRef(0);
  const [unread, setUnread] = useState(0);

  const shown = useMemo(() => ledgerItems(events, you), [events, you]);

  useEffect(() => {
    if (open) {
      listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: 'smooth' });
      lastSeen.current = events.length;
      setUnread(0);
    } else {
      setUnread(events.slice(lastSeen.current).filter((e) => e.type === 'chat').length);
    }
  }, [events, open]);

  const toggle = () => {
    const next = !open;
    setOpen(next);
    localStorage.setItem('love-letter:ledger', next ? 'open' : 'closed');
  };
  const send = (e: React.FormEvent) => {
    e.preventDefault();
    const t = text.trim();
    if (!t) return;
    setText('');
    void api.say(id, token, t).catch(() => {});
  };

  // Group by round for the expanded view.
  const groups: { label: string; items: LedgerItem[] }[] = [];
  for (const it of shown) {
    const t = it.kind === 'event' ? it.e.type : 'played';
    if (groups.length === 0) groups.push({ label: 'Lobby', items: [] });
    if (t === 'round_started' && it.kind === 'event') groups.push({ label: `Round ${it.e['round']}`, items: [] });
    groups[groups.length - 1]!.items.push(it);
  }
  const tail = shown.slice(-3);
  const newest = shown[shown.length - 1]?.seq;

  const line = (it: LedgerItem) => {
    if (it.kind === 'action') {
      return (
        <div key={it.seq} className={`entry action ${it.mine ? 'mine' : ''} ${it.seq === newest ? 'fresh' : ''}`}>
          <span className="n">{it.seq}</span>
          <span className="cards">
            {it.cards.map((c, i) => (
              <Card key={i} rank={c.rank} size="sm" className={i > 0 ? 'second' : ''} title={c.who ? `${c.who}: ${cardByRank(c.rank).name}` : cardByRank(c.rank).name} />
            ))}
          </span>
          <span className="t">
            <span className="line">{emphasize(it.played.text)}</span>
            {it.sub && <span className="sub">{emphasize(it.sub)}</span>}
          </span>
        </div>
      );
    }
    const e = it.e;
    return (
      <div key={e.seq} className={`entry t-${e.type} ${e['player'] === you ? 'mine' : ''}`}>
        <span className="n">{e.seq}</span>
        <span className="t">
          {e.type === 'chat'
            ? <><i>{e.text.slice(0, e.text.indexOf(': '))}</i> {e.text.slice(e.text.indexOf(': ') + 2)}</>
            : e.type === 'drew' && typeof e['card'] === 'number'
              ? <>You drew the <u>{cardByRank(e['card'] as Rank).name}</u>.</>
              : emphasize(e.text)}
        </span>
      </div>
    );
  };

  return (
    <section className={`ledger ${open ? 'open' : ''}`}>
      <button className="ledger-head" onClick={toggle} aria-expanded={open}>
        <span className="serif">History</span>
        <span className="muted small">{shown.length} entries · round {round}{unread ? ` · ${unread} new message${unread === 1 ? '' : 's'}` : ''}</span>
        <span className="spacer" />
        <span className="chev" aria-hidden="true">{open ? '−' : '+'}</span>
      </button>
      {open ? (
        <>
          <div className="ledger-list" ref={listRef}>
            {groups.map((grp, i) => (
              <div key={i} className="group">
                <div className="group-head">{grp.label}</div>
                {grp.items.map(line)}
              </div>
            ))}
          </div>
          <form className="ledger-chat" onSubmit={send}>
            <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Say something to the table" maxLength={500} />
            <button className="btn btn-sm" type="submit" disabled={!text.trim()}>Send</button>
          </form>
        </>
      ) : (
        <div className="ledger-tail">{tail.map(line)}</div>
      )}
    </section>
  );
}
