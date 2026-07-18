import type { IncomingMessage, ServerResponse } from 'http';
import { handleUpdate } from '../src/bot';

/**
 * Lee y parsea el cuerpo JSON de una petición HTTP entrante.
 */
async function readBody(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      try {
        resolve(JSON.parse(body));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

/**
 * Handler principal de Vercel para el webhook de Telegram.
 */
export default async function handler(
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  try {
    const update = await readBody(req);
    await handleUpdate(update);
    res.statusCode = 200;
    res.end('OK');
  } catch (error) {
    console.error('Error en el webhook:', error);
    // Siempre respondemos 200 para evitar reintentos de Telegram
    res.statusCode = 200;
    res.end('Error manejado internamente');
  }
}