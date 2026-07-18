// src/bot.ts
import { Telegraf, Context } from 'telegraf';
import { loadConfig } from './types';
import { parseOrder, formatOrderMessage, MenuItem } from './orderParser';

let bot: Telegraf<Context> | null = null;

// Menú de prueba fijo (hardcoded) para no depender de Google Sheets aún
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
        '¡Bienvenido! Este es un bot de prueba desplegado en Vercel con Telegraf.'
      );
    });

    // Handler de texto libre: ahora interpreta pedidos con IA
    bot.on('text', async (ctx) => {
      const textoDelUsuario = ctx.message.text;

      try {
        // Llamada a DeepSeek para interpretar el pedido
        const orden = await parseOrder(textoDelUsuario, menuDePrueba);
        const mensajeConfirmacion = formatOrderMessage(orden);
        await ctx.reply(mensajeConfirmacion);
      } catch (error) {
        // Si algo falla (red, API, JSON inválido persistente), informamos al usuario
        console.error('Error procesando el pedido:', error);
        await ctx.reply('Hubo un error procesando tu pedido, intenta de nuevo.');
      }
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