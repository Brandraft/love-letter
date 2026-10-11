import { useEffect, useState } from 'react';
import { Home } from './Home';
import { Room } from './Room';

function usePath() {
  const [path, setPath] = useState(window.location.pathname);
  useEffect(() => {
    const onPop = () => setPath(window.location.pathname);
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
  const navigate = (to: string) => { window.history.pushState({}, '', to); setPath(to); };
  return { path, navigate };
}

export function App() {
  const { path, navigate } = usePath();
  const m = path.match(/^\/r\/([a-z0-9]+)\/?$/i);
  if (m) return <Room id={m[1]!.toLowerCase()} navigate={navigate} />;
  return <Home navigate={navigate} />;
}
