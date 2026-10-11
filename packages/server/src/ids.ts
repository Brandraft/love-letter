import { createHash, randomBytes } from 'node:crypto';

const ROOM_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789'; // no 0/o/1/l/i

export function roomId(): string {
  const bytes = randomBytes(6);
  let s = '';
  for (const b of bytes) s += ROOM_ALPHABET[b % ROOM_ALPHABET.length];
  return s;
}

export function playerId(): string {
  return randomBytes(5).toString('hex');
}

export function token(): string {
  return randomBytes(24).toString('base64url');
}

export function hashToken(t: string): string {
  return createHash('sha256').update(t).digest('hex');
}
