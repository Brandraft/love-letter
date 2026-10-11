import { useEffect, useState } from 'react';

export type Theme = 'light' | 'dark';
const KEY = 'love-letter:theme';

function current(): Theme {
  return document.documentElement.dataset['theme'] === 'dark' ? 'dark' : 'light';
}

/** The wall can be light or dark; the cards never change. Persisted, defaults to the OS preference. */
export function useTheme(): [Theme, () => void] {
  const [theme, setTheme] = useState<Theme>(current);
  useEffect(() => {
    document.documentElement.dataset['theme'] = theme;
    localStorage.setItem(KEY, theme);
  }, [theme]);
  return [theme, () => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))];
}

export function ThemeToggle({ className = 'link' }: { className?: string }) {
  const [theme, toggle] = useTheme();
  return (
    <button className={className} onClick={toggle} title="Switch between the light and dark wall">
      {theme === 'dark' ? 'Light' : 'Dark'}
    </button>
  );
}
