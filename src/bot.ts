import { Telegraf, Context } from 'telegraf';
import { loadConfig } from './types';

let bot: Telegraf<Context> | null = null;

export function getBot(): Telegraf<Context> {
  if (!bot) {
    const config = loadConfig();

    bot = new Telegraf<Context>(config.botToken);

    // Comando /start
    bot.start((ctx) => {
      return ctx.reply(
        '¡Bienvenido! Este es un bot de prueba desplegado en Vercel con Telegraf.'
      );
    });

    // Handler de texto libre (echo + chat_id)
    bot.on('text', (ctx) => {
      const messageText = ctx.message.text;
      const chatId = ctx.chat.id;
      return ctx.reply(`Echo: ${messageText}\nChat ID: ${chatId}`);
    });

    // Manejador global de errores de Telegraf
    bot.catch((err, ctx) => {
      console.error(`Error en update ${ctx.updateType}`, err);
    });
  }

  return bot;
}

/**
 * Procesa un update completo de Telegram.
 * Esta función se usa en el webhook serverless.
 */
export async function handleUpdate(update: any): Promise<void> {
  const bot = getBot();
  await bot.handleUpdate(update);
}