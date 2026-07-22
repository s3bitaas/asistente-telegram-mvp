// src/bot.ts
import { Telegraf, Context, Markup } from 'telegraf';
import { loadConfig } from './types';
import { parseOrder, formatOrderMessage, MenuItem } from './orderParser';
import {
  rateLimiter,
  checkAndSetDedup,
  saveOrder,
  deleteOrder,
} from './redis';

let bot: Telegraf<Context> | null = null;

// Menú de prueba (hardcodeado)
const menuDePrueba: MenuItem[] = [
  {
    nombre: 'Torta de Milanesa',
    tipo: 'base',
    precio: 100,
    sinonimos: ['torta de mila', 'milanga', 'milanesa'],
  },
  {
    nombre: 'Tacos al Pastor',
    tipo: 'base',
    precio: 25,
    sinonimos: ['taco al pastor', 'pastor', 'tacos pastor'],
  },
  {
    nombre: 'Ensalada César',
    tipo: 'base',
    precio: 80,
    sinonimos: ['ensalada', 'cesar', 'ensalada cesar'],
  },
  {
    nombre: 'Queso',
    tipo: 'extra',
    precio: 10,
    sinonimos: ['quesito', 'quesillo', 'extra queso'],
  },
  {
    nombre: 'Aguacate',
    tipo: 'extra',
    precio: 15,
    sinonimos: ['palta', 'aguacate extra', 'extra aguacate'],
  },
];

export function getBot(): Telegraf<Context> {
  if (!bot) {
    const config = loadConfig();

    bot = new Telegraf<Context>(config.botToken);

    // Comando /start
    bot.start((ctx) => {
      return ctx.reply(
        '¡Bienvenido! Envíame tu pedido y lo registraré.'
      );
    });

    // Handler de texto (pedidos)
    bot.on('text', async (ctx) => {
      const texto = ctx.message.text;
      const chatId = ctx.chat.id;
      const messageId = ctx.message.message_id;

      try {
        // --- Rate limit diario ---
        const { success, limit, remaining } = await rateLimiter.limit(
          `rate:${chatId}`
        );
        if (!success) {
          // Enviamos el aviso solo una vez; el rate limit se encarga de no repetir
          await ctx.reply('Has alcanzado el límite diario de mensajes. Vuelve mañana.');
          return;
        }

        // --- Deduplicación por mensaje ---
        const esNuevo = await checkAndSetDedup(chatId, messageId);
        if (!esNuevo) {
          // Mensaje duplicado, lo ignoramos silenciosamente
          return;
        }

        // --- Parseo del pedido con IA ---
        const orden = await parseOrder(texto, menuDePrueba);

        // Guardamos el pedido en Redis (TTL 24h)
        await saveOrder(chatId, messageId, orden);

        // Formateamos la confirmación
        const mensajeConfirmacion = formatOrderMessage(orden);

        // Enviamos el mensaje con los botones inline
        await ctx.reply(mensajeConfirmacion, {
          reply_markup: Markup.inlineKeyboard([
            [
              Markup.button.callback('Cancelar', `cancelar:${chatId}:${messageId}`),
              Markup.button.callback('Modificar', `modificar:${chatId}:${messageId}`),
            ],
          ]).reply_markup,
        });
      } catch (error) {
        console.error('Error procesando el pedido:', error);
        await ctx.reply('Hubo un error procesando tu pedido, intenta de nuevo.');
      }
    });

    // --- Handler de callback_query (botones inline) ---
    bot.action(/^(cancelar|modificar):(-?\d+):(\d+)$/, async (ctx) => {
      const accion = ctx.match[1];       // "cancelar" o "modificar"
      const chatIdFromData = parseInt(ctx.match[2], 10);
      const messageId = parseInt(ctx.match[3], 10);

      // Verificación de autorización: solo el mismo chat puede ejecutar la acción
      if (ctx.chat?.id !== chatIdFromData) {
        return ctx.answerCbQuery('No puedes modificar este pedido.', { show_alert: false });
      }

      if (accion === 'cancelar') {
        try {
          // Borramos el pedido de Redis
          await deleteOrder(chatIdFromData, messageId);
          // Editamos el mensaje original
          await ctx.editMessageText('❌ Pedido cancelado');
          await ctx.answerCbQuery('Cancelado');
        } catch (err) {
          console.error('Error cancelando:', err);
          await ctx.answerCbQuery('Error al cancelar');
        }
      } else if (accion === 'modificar') {
        // Placeholder para modificación futura
        await ctx.answerCbQuery('Escribe el pedido corregido y lo reemplazo', { show_alert: false });
        // Aquí después implementarás la lógica de reemplazo
      }
    });

    // Manejo global de errores de Telegraf
    bot.catch((err, ctx) => {
      console.error(`Error en update ${ctx.updateType}`, err);
    });
  }

  return bot;
}

/**
 * Procesa un update completo de Telegram.
 */
export async function handleUpdate(update: any): Promise<void> {
  const bot = getBot();
  await bot.handleUpdate(update);
}