// src/bot.ts
import { Telegraf, Context, Markup } from 'telegraf';
import { loadConfig } from './types';
import { parseOrder, formatOrderMessage, MenuItem } from './orderParser';
import {
  rateLimiter,
  checkAndSetDedup,
  saveOrder,
  deleteOrder,
  getOrder,
} from './redis';
import { writeMenuTab, batchWriteSales } from './googleSheets';
import {
  isChatInRegistration,
  startRegistration,
  handleRegistrationStep,
} from './onboarding';

let bot: Telegraf<Context> | null = null;

const TEST_SHEET_ID = process.env.TEST_SHEET_ID || 'tu-id-de-prueba';

export function getBot(): Telegraf<Context> {
  if (!bot) {
    const config = loadConfig();

    bot = new Telegraf<Context>(config.botToken);

    // Comando /start (bienvenida genérica)
    bot.start((ctx) => {
      return ctx.reply(
        '¡Bienvenido! Envíame tu pedido y lo registraré.'
      );
    });

    // Comando /registrar – inicia el flujo de onboarding
    bot.command('registrar', async (ctx) => {
      const chatId = ctx.chat.id;
      try {
        const mensaje = await startRegistration(chatId);
        await ctx.reply(mensaje, { parse_mode: 'Markdown' });
      } catch (error) {
        console.error('Error en /registrar:', error);
        await ctx.reply('❌ Ocurrió un error al iniciar el registro. Intenta más tarde.');
      }
    });

    // Handler de texto (pedidos y flujo de registro)
    bot.on('text', async (ctx) => {
      const texto = ctx.message.text;
      const chatId = ctx.chat.id;
      const messageId = ctx.message.message_id;

      // --- Flujo de onboarding activo ---
      if (isChatInRegistration(chatId)) {
        try {
          const respuesta = await handleRegistrationStep(chatId, texto);
          if (respuesta) {
            await ctx.reply(respuesta, { parse_mode: 'Markdown' });
          }
        } catch (error) {
          console.error('Error en paso de registro:', error);
          await ctx.reply('❌ Error inesperado. Usa /registrar para reiniciar.');
        }
        return; // Salir, no procesar como pedido
      }

      // --- Procesamiento normal de pedidos ---
      try {
        // --- Rate limit diario ---
        const { success, limit, remaining } = await rateLimiter.limit(
          `rate:${chatId}`
        );
        if (!success) {
          await ctx.reply('Has alcanzado el límite diario de mensajes. Vuelve mañana.');
          return;
        }

        // --- Deduplicación por mensaje ---
        const esNuevo = await checkAndSetDedup(chatId, messageId);
        if (!esNuevo) {
          return;
        }

        // --- Obtener menú desde Google Sheets ---
        const menu = await writeMenuTab(TEST_SHEET_ID);

        // --- Parseo del pedido con IA ---
        const orden = await parseOrder(texto, menu);

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
        const mensajeConfirmacion = `${textoOriginal}\n\n¿Seguro que quieres cancelar este pedido?`;

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