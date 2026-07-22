// src/redis.ts
import { Redis } from '@upstash/redis';
import { Ratelimit } from '@upstash/ratelimit';
import type { ParsedOrder } from './orderParser';

const redisUrl = process.env.UPSTASH_REDIS_REST_URL;
const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN;
if (!redisUrl || !redisToken) {
  throw new Error('Faltan variables de entorno UPSTASH_REDIS_REST_URL o UPSTASH_REDIS_REST_TOKEN');
}

export const redis = new Redis({
  url: redisUrl,
  token: redisToken,
});

export const rateLimiter = new Ratelimit({
  redis,
  limiter: Ratelimit.slidingWindow(400, '24 h'),
  analytics: false,
  prefix: 'rate',
});

interface StoredOrder {
  order: ParsedOrder;
  timestamp: number;
}

export async function saveOrder(
  chatId: number | string,
  messageId: number,
  order: ParsedOrder
): Promise<void> {
  const key = `pedido:${chatId}:${messageId}`;
  const value: StoredOrder = {
    order,
    timestamp: Date.now(),
  };
  await redis.set(key, JSON.stringify(value), { ex: 86400 });
}

export async function getOrder(
  chatId: number | string,
  messageId: number
): Promise<StoredOrder | null> {
  const key = `pedido:${chatId}:${messageId}`;
  const data = await redis.get<StoredOrder>(key);
  if (!data) return null;
  return typeof data === 'string' ? (JSON.parse(data) as StoredOrder) : data;
}

export async function deleteOrder(
  chatId: number | string,
  messageId: number
): Promise<void> {
  const key = `pedido:${chatId}:${messageId}`;
  await redis.del(key);
}

export async function checkAndSetDedup(
  chatId: number | string,
  messageId: number
): Promise<boolean> {
  const key = `dedup:${chatId}:${messageId}`;
  const result = await redis.set(key, '1', { nx: true, ex: 120 });
  return result === 'OK';
}

export async function getDailyOrders(
  chatId: number | string
): Promise<StoredOrder[]> {
  const pattern = `pedido:${chatId}:*`;
  const orders: StoredOrder[] = [];
  let cursor: number | undefined = 0;

  const startOfDay = new Date();
  startOfDay.setUTCHours(0, 0, 0, 0);
  const startTimestamp = startOfDay.getTime();

  do {
    const result = await redis.scan(cursor, { match: pattern, count: 100 });
    cursor = result[0] === 0 ? undefined : result[0];
    const keys = result[1];

    if (keys.length > 0) {
      const pipeline = redis.pipeline();
      keys.forEach((key) => pipeline.get(key));
      const values = await pipeline.exec<string[]>();
      for (let i = 0; i < values.length; i++) {
        if (!values[i]) continue;
        const raw = values[i];
const stored: StoredOrder = typeof raw === 'string' ? JSON.parse(raw) : (raw as StoredOrder);
        if (stored.timestamp >= startTimestamp) {
          orders.push(stored);
        }
      }
    }
  } while (cursor !== undefined);

  orders.sort((a, b) => b.timestamp - a.timestamp);
  return orders;
}