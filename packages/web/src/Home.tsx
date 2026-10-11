import { useState } from 'react';
import { CARDS } from '@love-letter/engine';
import { api, ApiError } from './api';
import { Card } from './Card';
import { ThemeToggle } from './theme';

export function Home({ navigate }: { navigate: (to: string) => void }) {
  const [busy, setBusy] = useState(false);
  const [code, setCode] = useState('');
  const [error, setError] = useState('');

  async function create() {
    setBusy(true); setError('');
    try {
      const r = await api.createRoom();
      navigate(`/r/${r.id}`);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'could not create a room');
    } finally { setBusy(false); }
  }

  function join(e: React.FormEvent) {
    e.preventDefault();
    const id = code.trim().toLowerCase().replace(/^.*\/r\//, '');
    if (id) navigate(`/r/${id}`);
  }

  return (
    <main className="home">
      <div className="home-tools"><ThemeToggle /></div>
      <p className="label">A game of risk, deduction and luck · 2 to 4 players</p>
      <h1 style={{ marginTop: 10 }}>Love Letter</h1>
      <p className="lede">
        Get your letter to the Princess before your rivals do. One card in hand, one decision a turn.
        Play in the browser, from a terminal, or let your agents play.
      </p>
      <div className="actions">
        <button className="btn" onClick={create} disabled={busy}>Create a room</button>
        <form className="join" onSubmit={join}>
          <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="room code or link" aria-label="room code" />
          <button className="link" type="submit" disabled={!code.trim()}>Join</button>
        </form>
      </div>
      {error && <p className="error">{error}</p>}

      <section className="section">
        <h2>The deck</h2>
        <div className="deck">
          {CARDS.map((c) => (
            <div key={c.rank} className="deck-item">
              <Card rank={c.rank} size="md" />
              <p><b>×{c.count}</b> · {c.effect}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="section">
        <h2>Also a terminal game</h2>
        <p className="muted" style={{ marginTop: 10 }}>Every room is an API. Fetch a room link with curl and it explains itself.</p>
        <pre>{`curl -s -X POST ${window.location.origin}/api/rooms
curl -s ${window.location.origin}/r/<room>`}</pre>
      </section>
    </main>
  );
}
