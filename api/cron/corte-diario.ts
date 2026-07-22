// api/cron/corte-diario.ts
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getDailyOrders } from '../../src/redis';
import { batchWriteSales } from '../../src/googleSheets';
import type { ParsedOrder } from '../../src/orderParser';

/**
 * Cron Job: cierre de caja diario.
 * Se activa a las 22:00 America/Mexico_City mediante vercel.json crons.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  // 1. Verificar secreto de autorización
  const authHeader = req.headers.authorization;
  const secret = process.env.CRON_SECRET;
  if (!secret || authHeader !== `Bearer ${secret}`) {
    res.status(401).json({ error: 'No autorizado' });
    return;
  }

  const botToken = process.env.BOT_TOKEN;
  const adminChatId = process.env.ADMIN_TELEGRAM_ID;
  const testSheetId = process.env.TEST_SHEET_ID;

  if (!botToken || !adminChatId || !testSheetId) {
    console.error('Faltan variables de entorno para el corte diario');
    res.status(500).json({ error: 'Configuración incompleta' });
    return;
  }

  try {
    // 2. Obtener pedidos del día (Redis)
    const pedidosGuardados = await getDailyOrders(adminChatId);
    const pedidos: ParsedOrder[] = pedidosGuardados.map((stored) => stored.order);

    if (pedidos.length === 0) {
      // Sin pedidos hoy, igual notificamos (opcional) y terminamos
      await sendTelegramMessage(
        botToken,
        adminChatId,
        '📊 *Corte diario:*\nNo hubo pedidos registrados hoy.'
      );
      res.status(200).json({ message: 'Sin pedidos' });
      return;
    }

    // 3. Escribir todas las órdenes en Google Sheets (pestaña "Ventas")
    await batchWriteSales(testSheetId, pedidos);

    // 4. Calcular resumen
    let totalVentas = 0;
    const contadorProductos: Record<string, number> = {};
    for (const pedido of pedidos) {
      totalVentas += pedido.total_pedido;
      for (const item of pedido.items) {
        contadorProductos[item.producto] =
          (contadorProductos[item.producto] || 0) + item.cantidad;
      }
    }
    // Producto más vendido (por unidades)
    let productoTop = '';
    let maxUnidades = 0;
    for (const [producto, cantidad] of Object.entries(contadorProductos)) {
      if (cantidad > maxUnidades) {
        maxUnidades = cantidad;
        productoTop = producto;
      }
    }

    // 5. Enviar resumen al administrador por Telegram
    const mensaje =
      `📊 *Corte diario automático*\n\n` +
      `📦 Pedidos procesados: ${pedidos.length}\n` +
      `💰 Total vendido: $${totalVentas.toFixed(2)}\n` +
      `🏆 Producto estrella: *${productoTop}* (${maxUnidades} unidades)\n\n` +
      `Los datos se han escrito en la hoja de Ventas.`;

    await sendTelegramMessage(botToken, adminChatId, mensaje);

    res.status(200).json({ message: 'Corte diario exitoso', totalVentas, productoTop });
  } catch (error) {
    console.error('Error en corte diario:', error);
    // Intentamos notificar al admin incluso si falló
    try {
      await sendTelegramMessage(
        botToken,
        adminChatId,
        '❌ *Error en el corte diario automático.* Revisa los logs de Vercel.'
      );
    } catch (_) { /* ignorar fallo de notificación */ }
    res.status(500).json({ error: 'Error en corte diario' });
  }
}

/**
 * Envía un mensaje de Telegram usando la API directamente (fetch).
 */
async function sendTelegramMessage(
  token: string,
  chatId: string,
  text: string
): Promise<void> {
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: 'Markdown',
    }),
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Telegram API error: ${res.status} ${errText}`);
  }
}