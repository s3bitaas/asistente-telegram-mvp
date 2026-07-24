// src/onboarding.ts
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { duplicateMasterTemplate } from './googleSheets';
import { redis } from './redis'; // cliente Upstash ya configurado

// ---------------------------------------------------------------------------
// Tipos internos
// ---------------------------------------------------------------------------

interface RegistrationState {
  step: 'nombre' | 'telefono' | 'correo';
  nombre?: string;
  telefono?: string;
  correo?: string;
}

// ---------------------------------------------------------------------------
// Cliente Supabase (se inicializa una sola vez)
// ---------------------------------------------------------------------------

const supabaseUrl = process.env.SUPABASE_URL || '';
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

let supabase: SupabaseClient | null = null;
function getSupabase(): SupabaseClient {
  if (!supabase) {
    if (!supabaseUrl || !supabaseServiceKey) {
      throw new Error('Faltan variables SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY');
    }
    supabase = createClient(supabaseUrl, supabaseServiceKey);
  }
  return supabase;
}

// ---------------------------------------------------------------------------
// Almacén de estados en Redis (persiste entre invocaciones serverless)
// ---------------------------------------------------------------------------

const STATE_TTL = 3600; // 1 hora

function buildKey(chatId: number): string {
  return `registro:${chatId}`;
}

/**
 * Verifica si un chat_id se encuentra en proceso de registro.
 */
export async function isChatInRegistration(chatId: number): Promise<boolean> {
  const key = buildKey(chatId);
  const exists = await redis.exists(key);
  return exists > 0;
}

/**
 * Inicia el flujo de registro para un chat.
 * Si el negocio ya existe en Supabase, responde con un mensaje y no inicia.
 * Si existe un registro incompleto (sin sheet_id), lo borra y permite reiniciar.
 */
export async function startRegistration(chatId: number): Promise<string> {
  const db = getSupabase();

  // Verificar si ya existe en la tabla negocios, y si está completo
  const { data: existing, error } = await db
    .from('negocios')
    .select('id, sheet_id')
    .eq('telegram_chat_id', chatId)
    .maybeSingle();

  if (error) throw new Error(`Error al consultar Supabase: ${error.message}`);

  if (existing) {
    if (existing.sheet_id) {
      // Registro completo, no permitir duplicado
      return '⚠️ Tu negocio ya está registrado. Si necesitas ayuda, contacta al administrador.';
    } else {
      // Registro incompleto (sin sheet_id): limpiar para permitir reintento
      await db.from('negocios').delete().eq('id', existing.id);
      // Continuar con el flujo normal
    }
  }

  // Iniciar estado en Redis con TTL de 1 hora
  const initialState: RegistrationState = { step: 'nombre' };
  await redis.set(buildKey(chatId), JSON.stringify(initialState), { ex: STATE_TTL });

  return '🍽️ ¡Vamos a registrar tu negocio!\n\nPrimero, ¿cuál es el nombre del negocio?';
}

/**
 * Procesa la respuesta de un paso del registro.
 * Devuelve un objeto con el texto y, opcionalmente, parseMode 'Markdown'.
 */
export async function handleRegistrationStep(
  chatId: number,
  text: string
): Promise<{ text: string; parseMode?: 'Markdown' } | null> {
  const key = buildKey(chatId);
  const data = await redis.get<string | RegistrationState>(key);
  if (!data) return null;

  let state: RegistrationState;
  if (typeof data === 'string') {
    try {
      state = JSON.parse(data);
    } catch {
      await redis.del(key);
      return { text: '❌ Ocurrió un error con el estado del registro. Usa /registrar para empezar de nuevo.' };
    }
  } else {
    state = data as RegistrationState;
  }

  const trimmed = text.trim();

  switch (state.step) {
    case 'nombre':
      if (trimmed.length === 0) {
        return { text: '❌ El nombre no puede estar vacío. Intenta de nuevo:' };
      }
      state.nombre = trimmed;
      state.step = 'telefono';
      await redis.set(key, JSON.stringify(state), { ex: STATE_TTL });
      return { text: '📞 Ahora escribe el número de teléfono (10 dígitos):' };

    case 'telefono':
      if (!/^\d{10}$/.test(trimmed)) {
        return { text: '❌ El teléfono debe tener exactamente 10 dígitos numéricos. Ejemplo: 5512345678' };
      }
      state.telefono = trimmed;
      state.step = 'correo';
      await redis.set(key, JSON.stringify(state), { ex: STATE_TTL });
      return { text: '📧 Por último, escribe el correo electrónico:' };

    case 'correo':
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
        return { text: '❌ El correo no tiene un formato válido. Intenta de nuevo:' };
      }
      state.correo = trimmed;

      try {
        return await completarRegistro(chatId, state);
      } catch (error: any) {
        await redis.del(key);
        return { text: `❌ Ocurrió un error durante el registro: ${error.message}. Por favor intenta de nuevo más tarde o contacta al administrador.` };
      }

    default:
      return { text: 'Estado desconocido. Usa /registrar para comenzar.' };
  }
}

/**
 * Ejecuta la inserción en Supabase y la duplicación de la plantilla.
 * Si falla después de insertar, hace rollback (borra la fila) para permitir reintentos.
 */
async function completarRegistro(
  chatId: number,
  state: RegistrationState
): Promise<{ text: string; parseMode?: 'Markdown' }> {
  const db = getSupabase();
  const nombreNegocio = state.nombre!;
  const telefono = state.telefono!;
  const correo = state.correo!;

  // 1. Insertar en tabla negocios (sin sheet_id aún)
  const { data: nuevoNegocio, error: insertError } = await db
    .from('negocios')
    .insert({
      telegram_chat_id: chatId,
      nombre_negocio: nombreNegocio,
      telefono,
      correo,
      fecha_registro: new Date().toISOString(),
      activo: true,
    })
    .select('id')
    .single();

  if (insertError) {
    throw new Error(`Error al insertar en Supabase: ${insertError.message}`);
  }

  // 2. Duplicar plantilla maestra y actualizar sheet_id (con rollback si falla)
  try {
    const { sheetId, sheetUrl } = await duplicateMasterTemplate(nombreNegocio, correo);

    const { error: updateError } = await db
      .from('negocios')
      .update({ sheet_id: sheetId })
      .eq('id', nuevoNegocio.id);

    if (updateError) {
      throw new Error(
        `Se creó la hoja de cálculo pero no se pudo guardar el ID: ${updateError.message}. Contacta al administrador con este dato: Sheet ID = ${sheetId}`
      );
    }

    // 3. Limpiar estado de Redis
    const key = buildKey(chatId);
    await redis.del(key);

    // 4. Mensaje de éxito (con Markdown)
    return {
      text:
        `✅ *¡Registro exitoso!*\n\n` +
        `Tu hoja de cálculo está lista:\n` +
        `[Ver hoja](${sheetUrl})\n\n` +
        `A partir de ahora puedes recibir pedidos.\n\n` +
        `⚠️ Si al abrir el enlace te pide "solicitar acceso", significa que tu correo no está vinculado a una Cuenta de Google. Para solucionarlo, crea una cuenta en [accounts.google.com/signup](https://accounts.google.com/signup) usando la opción "usar mi dirección de correo actual" con el mismo correo (${correo}).`,
      parseMode: 'Markdown',
    };
  } catch (error) {
    // Rollback: borrar la fila insertada para que el negocio pueda reintentar
    await db.from('negocios').delete().eq('id', nuevoNegocio.id);
    throw error; // re-lanzar para que el caller muestre el error al usuario
  }
}

// ---------------------------------------------------------------------------
// Obtiene los datos del negocio asociado a un chat de Telegram
// ---------------------------------------------------------------------------

/**
 * Obtiene los datos del negocio asociado a un chat de Telegram.
 * @returns Objeto con id, sheet_id y activo, o null si no existe.
 */
export async function getNegocioByChatId(
  chatId: number
): Promise<{ id: string; sheet_id: string; activo: boolean } | null> {
  const db = getSupabase();
  const { data, error } = await db
    .from('negocios')
    .select('id, sheet_id, activo')
    .eq('telegram_chat_id', chatId)
    .maybeSingle();

  if (error) throw new Error(`Error al consultar negocios: ${error.message}`);
  if (!data) return null;

  return {
    id: String(data.id),
    sheet_id: data.sheet_id || '',
    activo: data.activo,
  };
}