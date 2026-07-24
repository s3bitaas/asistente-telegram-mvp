// api/cron/corte-diario.ts
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';
import { getDailyOrders } from '../../src/redis';
import { batchWriteSales } from '../../src/googleSheets';
import type { ParsedOrder } from '../../src/orderParser';

// ---------------------------------------------------------------------------
// Tipos locales
// ---------------------------------------------------------------------------

interface NegocioActivo {
  telegram_chat_id: number;
  sheet_id: string;
  nombre_negocio: string;
}

interface ResumenNegocio {
  nombre: string;
  chatId: number;
  pedidos: number;
  total: number;
  productoTop: string;
  error?: string;
}

// ---------------------------------------------------------------------------
// Cliente Supabase (inicialización única)
// ---------------------------------------------------------------------------

const supabaseUrl = process.env.SUPABASE_URL || '';
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

function getSupabaseClient() {
  if (!supabaseUrl || !supabaseServiceKey) {
    throw new Error('Faltan variables SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY');
  }
  return createClient(supabaseUrl, supabaseServiceKey);
}

// ---------------------------------------------------------------------------
// Handler principal
// ---------------------------------------------------------------------------

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

  if (!botToken || !adminChatId) {
    console.error('Faltan variables BOT_TOKEN o ADMIN_TELEGRAM_ID');
    res.status(500).json({ error: 'Configuración incompleta' });
    return;
  }

  const db = getSupabaseClient();

  // 2. Obtener todos los negocios activos
  const { data: negocios, error: queryError } = await db
    .from('negocios')
    .select('telegram_chat_id, sheet_id, nombre_negocio')
    .eq('activo', true);

  if (queryError) {
    console.error('Error al consultar negocios:', queryError);
    res.status(500).json({ error: 'Error al obtener negocios' });
    return;
  }

  if (!negocios || negocios.length === 0) {
    // Sin negocios, igual notificamos al admin
    await sendTelegramMessage(
      botToken,
      adminChatId,
      '📊 *Corte diario:* No hay negocios activos registrados.'
    );
    res.status(200).json({ message: 'Sin negocios activos' });
    return;
  }

  // 3. Procesar cada negocio
  const resumenes: ResumenNegocio[] = [];
  let totalGlobal = 0;
  let negociosConPedidos = 0;
  const errores: string[] = [];

  for (const negocio of negocios as NegocioActivo[]) {
    const chatId = negocio.telegram_chat_id;
    const sheetId = negocio.sheet_id;
    const nombre = negocio.nombre_negocio;

    if (!sheetId) {
      // Si no tiene sheet_id, no se puede escribir, se registra error
      errores.push(`${nombre} (${chatId}): no tiene sheet_id configurado`);
      continue;
    }

    try {
      // Obtener pedidos del día desde Redis
      const pedidosGuardados = await getDailyOrders(chatId);
      const pedidos: ParsedOrder[] = pedidosGuardados.map((s) => s.order);

      if (pedidos.length === 0) {
        // Sin pedidos hoy, no se envía mensaje a este negocio
        resumenes.push({
          nombre,
          chatId,
          pedidos: 0,
          total: 0,
          productoTop: '-',
        });
        continue;
      }

      // Escribir en Google Sheets
      await batchWriteSales(sheetId, pedidos);

      // Calcular resumen para este negocio
      let totalVentas = 0;
      const contadorProductos: Record<string, number> = {};
      for (const pedido of pedidos) {
        totalVentas += pedido.total_pedido;
        for (const item of pedido.items) {
          contadorProductos[item.producto] =
            (contadorProductos[item.producto] || 0) + item.cantidad;
        }
      }

      let productoTop = '';
      let maxUnidades = 0;
      for (const [prod, cant] of Object.entries(contadorProductos)) {
        if (cant > maxUnidades) {
          maxUnidades = cant;
          productoTop = prod;
        }
      }

      totalGlobal += totalVentas;
      negociosConPedidos++;

      resumenes.push({
        nombre,
        chatId,
        pedidos: pedidos.length,
        total: totalVentas,
        productoTop,
      });

      // Enviar mensaje al negocio
      const mensajeNegocio =
        `📊 *Corte diario*\n` +
        `📦 Pedidos: ${pedidos.length}\n` +
        `💰 Total: $${totalVentas.toFixed(2)}\n` +
        `🏆 Producto estrella: *${productoTop}* (${maxUnidades} unidades)`;

      await sendTelegramMessage(botToken, String(chatId), mensajeNegocio);
    } catch (error: any) {
      const errMsg = `${nombre} (${chatId}): ${error.message || error}`;
      console.error('Error procesando negocio:', errMsg);
      errores.push(errMsg);
      resumenes.push({
        nombre,
        chatId,
        pedidos: 0,
        total: 0,
        productoTop: '-',
        error: errMsg,
      });
    }
  }

  // 4. Mensaje consolidado al admin
  const totalNegocios = negocios.length;
  const lineasAdmin: string[] = [
    '📊 *Corte diario multi‑negocio*',
    `🏪 Negocios activos: ${totalNegocios}`,
    `🛒 Negocios con pedidos: ${negociosConPedidos}`,
    `💵 Venta total consolidada: $${totalGlobal.toFixed(2)}`,
  ];

  if (errores.length > 0) {
    lineasAdmin.push(`\n⚠️ Errores: ${errores.length}`);
    errores.forEach((e) => lineasAdmin.push(`- ${e}`));
  }

  await sendTelegramMessage(botToken, adminChatId, lineasAdmin.join('\n'));

  res.status(200).json({
    message: 'Corte diario completado',
    totalNegocios,
    negociosConPedidos,
    totalGlobal,
    errores,
  });
}

// ---------------------------------------------------------------------------
// Función auxiliar para enviar mensajes de Telegram
// ---------------------------------------------------------------------------

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