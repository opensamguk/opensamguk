import { hash, verify, argon2id } from 'argon2';
import { z } from 'zod';
export const passwordSchema = z.string().min(10).max(128);
export function hashPassword(password: string) {
  return hash(password, { type: argon2id, memoryCost: 65536, timeCost: 3, parallelism: 4 });
}
export function verifyPassword(encoded: string, password: string) {
  return verify(encoded, password);
}
