// src/bot.ts
import { Telegraf, Context, Markup } from 'telegraf';
import { loadConfig } from './types';
import { parseOrder, formatOrderMessage, MenuItem } from './orderParser';
import {
  rateLimiter,
  checkAndSetDedup,
  saveOrder,
  deleteOrder,
  getOrder, // ← añadir
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
    // 1. Acción "cancelar" – muestra confirmación
bot.action(/^cancelar:(-?\d+):(\d+)$/, async (ctx) => {
  const chatIdFromData = parseInt(ctx.match[1], 10);
  const messageId = parseInt(ctx.match[2], 10);

  // Verificar autorización (mismo chat)
  if (ctx.chat?.id !== chatIdFromData) {
    return ctx.answerCbQuery('No puedes modificar este pedido.', { show_alert: false });
  }

  try {
    // Recuperar el pedido de Redis para regenerar el mensaje original
    const stored = await getOrder(chatIdFromData, messageId);
    if (!stored) {
      // Si el pedido ya no existe, informamos y limpiamos los botones
      await ctx.editMessageText('❌ El pedido ya no está disponible.');
      await ctx.answerCbQuery('Pedido no encontrado');
      return;
    }

    const order = stored.order;
    // Texto original del pedido
    const textoOriginal = formatOrderMessage(order);

    // Nuevo mensaje de confirmación
    const mensajeConfirmacion = `${textoOriginal}\n\n¿Seguro que quieres cancelar este pedido?`;

    // Botones de confirmación y regreso
    await ctx.editMessageText(mensajeConfirmacion, {
      reply_markup: {
        inline_keyboard: [
          [
            Markup.button.callback('✅ Sí, cancelar', `confirmar_cancelar:${chatIdFromData}:${messageId}`),
            Markup.button.callback('◀️ No, regresar', `volver:${chatIdFromData}:${messageId}`),
          ],
        ],
      },
    });
    await ctx.answerCbQuery();
  } catch (error) {
    console.error('Error en cancelar:', error);
    await ctx.answerCbQuery('Error al procesar la cancelación', { show_alert: true });
  }
});

// 2. Acción "confirmar_cancelar" – borrado definitivo
bot.action(/^confirmar_cancelar:(-?\d+):(\d+)$/, async (ctx) => {
  const chatIdFromData = parseInt(ctx.match[1], 10);
  const messageId = parseInt(ctx.match[2], 10);

  if (ctx.chat?.id !== chatIdFromData) {
    return ctx.answerCbQuery('No puedes modificar este pedido.', { show_alert: false });
  }

  try {
    await deleteOrder(chatIdFromData, messageId);
    await ctx.editMessageText('❌ Pedido cancelado');
    await ctx.answerCbQuery('Cancelado');
  } catch (error) {
    console.error('Error en confirmar_cancelar:', error);
    await ctx.answerCbQuery('Error al cancelar', { show_alert: true });
  }
});

// 3. Acción "volver" – regresa al mensaje original con los botones normales
bot.action(/^volver:(-?\d+):(\d+)$/, async (ctx) => {
  const chatIdFromData = parseInt(ctx.match[1], 10);
  const messageId = parseInt(ctx.match[2], 10);

  if (ctx.chat?.id !== chatIdFromData) {
    return ctx.answerCbQuery('No puedes modificar este pedido.', { show_alert: false });
  }

  try {
    const stored = await getOrder(chatIdFromData, messageId);
    if (!stored) {
      await ctx.editMessageText('❌ El pedido ya no está disponible.');
      await ctx.answerCbQuery('Pedido no encontrado');
      return;
    }

    const order = stored.order;
    const textoOriginal = formatOrderMessage(order);

    // Volver a poner los botones originales: Cancelar y Modificar
    await ctx.editMessageText(textoOriginal, {
      reply_markup: {
        inline_keyboard: [
          [
            Markup.button.callback('Cancelar', `cancelar:${chatIdFromData}:${messageId}`),
            Markup.button.callback('Modificar', `modificar:${chatIdFromData}:${messageId}`),
          ],
        ],
      },
    });
    await ctx.answerCbQuery();
  } catch (error) {
    console.error('Error en volver:', error);
    await ctx.answerCbQuery('Error al restaurar el mensaje', { show_alert: true });
  }
});

// 4. Acción "modificar" – se mantiene igual (placeholder)
bot.action(/^modificar:(-?\d+):(\d+)$/, async (ctx) => {
  const chatIdFromData = parseInt(ctx.match[1], 10);
  const messageId = parseInt(ctx.match[2], 10);

  if (ctx.chat?.id !== chatIdFromData) {
    return ctx.answerCbQuery('No puedes modificar este pedido.', { show_alert: false });
  }

  await ctx.answerCbQuery('Escribe el pedido corregido y lo reemplazo', { show_alert: false });
  // Aquí se implementará la lógica de reemplazo más adelante
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