import { cardByRank, type Rank } from '@love-letter/engine';
import './card.css';

export type CardSize = 'sm' | 'md' | 'lg';

/** Pixel widths per size. Everything inside the card scales from this. */
export const CARD_WIDTH: Record<CardSize, number> = { sm: 56, md: 104, lg: 176 };

const srcset = (id: string) => `/cards/${id}-240.webp 240w, /cards/${id}-480.webp 480w, /cards/${id}-960.webp 960w`;

export function Card({
  rank, size = 'md', selected, disabled, dim, onClick, title, className = '',
}: {
  rank: Rank; size?: CardSize; selected?: boolean; disabled?: boolean; dim?: boolean;
  onClick?: () => void; title?: string; className?: string;
}) {
  const c = cardByRank(rank);
  const cls = ['card', `card-${size}`, selected ? 'is-selected' : '', disabled ? 'is-disabled' : '',
    dim ? 'is-dim' : '', onClick ? 'is-clickable' : '', className].filter(Boolean).join(' ');
  return (
    <div
      className={cls}
      style={{ '--card-w': `${CARD_WIDTH[size]}px` } as React.CSSProperties}
      onClick={disabled ? undefined : onClick}
      title={title ?? `${c.name}: ${c.effect}`}
      role={onClick ? 'button' : undefined}
      aria-label={`${c.name} (${c.rank})`}
    >
      <span className="card-rank">{c.rank}</span>
      <div className="card-window">
        <img
          src={`/cards/${c.id}-480.webp`}
          srcSet={srcset(c.id)}
          sizes={`${CARD_WIDTH[size]}px`}
          alt={`${c.name}, rank ${c.rank}`}
          draggable={false}
        />
      </div>
      {size !== 'sm' && <div className="card-name">{c.name}</div>}
      {size === 'lg' && <div className="card-effect">{c.effect}</div>}
    </div>
  );
}

export function CardBack({ size = 'md', className = '' }: { size?: CardSize; className?: string }) {
  return (
    <div className={`card card-back card-${size} ${className}`} style={{ '--card-w': `${CARD_WIDTH[size]}px` } as React.CSSProperties} aria-label="face-down card">
      <div className="card-back-field" />
      <svg className="card-back-mark" viewBox="0 0 100 100" aria-hidden="true">
        <circle cx="50" cy="50" r="44" fill="none" stroke="currentColor" strokeWidth="2.5" />
        <circle cx="50" cy="50" r="36" fill="none" stroke="currentColor" strokeWidth="1" opacity=".6" />
        <path d="M30 40h40v26H30z" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinejoin="round" />
        <path d="M30 40l20 15 20-15" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinejoin="round" />
        <circle cx="50" cy="57" r="5" fill="currentColor" />
      </svg>
    </div>
  );
}
