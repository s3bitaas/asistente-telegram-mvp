// src/onboarding.ts
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { duplicateMasterTemplate } from './googleSheets';

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
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || ''; // usa service_role para inserciones

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
// Almacén de estados en memoria (dura lo que la función serverless esté caliente)
// ---------------------------------------------------------------------------

const registrationStates = new Map<number, RegistrationState>();

/**
 * Verifica si un chat_id ya se encuentra en proceso de registro.
 */
export function isChatInRegistration(chatId: number): boolean {
  return registrationStates.has(chatId);
}

/**
 * Inicia el flujo de registro para un chat.
 * Si el negocio ya existe en Supabase, responde con un mensaje y no inicia.
 * Devuelve el texto de la primera pregunta.
 */
export async function startRegistration(
  chatId: number
): Promise<string> {
  const db = getSupabase();

  // Verificar si ya existe en la tabla negocios
  const { data: existing, error } = await db
    .from('negocios')
    .select('telegram_chat_id')
    .eq('telegram_chat_id', chatId)
    .maybeSingle();

  if (error) throw new Error(`Error al consultar Supabase: ${error.message}`);
  if (existing) {
    return '⚠️ Tu negocio ya está registrado. Si necesitas ayuda, contacta al administrador.';
  }

  // Iniciar estado
  registrationStates.set(chatId, { step: 'nombre' });
  return '🍽️ ¡Vamos a registrar tu negocio!\n\nPrimero, ¿cuál es el nombre del negocio?';
}

/**
 * Procesa la respuesta de un paso del registro.
 * @param chatId ID del chat de Telegram
 * @param text Texto enviado por el usuario
 * @returns Respuesta que el bot debe enviar, o null si el flujo terminó (éxito o error manejado externamente)
 */
export async function handleRegistrationStep(
  chatId: number,
  text: string
): Promise<string | null> {
  const state = registrationStates.get(chatId);
  if (!state) return null; // no debería ocurrir

  const trimmed = text.trim();

  switch (state.step) {
    case 'nombre':
      if (trimmed.length === 0) {
        return '❌ El nombre no puede estar vacío. Intenta de nuevo:';
      }
      state.nombre = trimmed;
      state.step = 'telefono';
      return '📞 Ahora escribe el número de teléfono (10 dígitos):';

    case 'telefono':
      if (!/^\d{10}$/.test(trimmed)) {
        return '❌ El teléfono debe tener exactamente 10 dígitos numéricos. Ejemplo: 5512345678';
      }
      state.telefono = trimmed;
      state.step = 'correo';
      return '📧 Por último, escribe el correo electrónico:';

    case 'correo':
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
        return '❌ El correo no tiene un formato válido. Intenta de nuevo:';
      }
      state.correo = trimmed;

      // ----- Todos los datos completos: insertar y duplicar plantilla -----
      try {
        return await completarRegistro(chatId, state);
      } catch (error: any) {
        // Limpiar estado en caso de error grave
        registrationStates.delete(chatId);
        return `❌ Ocurrió un error durante el registro: ${error.message}. Por favor intenta de nuevo más tarde o contacta al administrador.`;
      }

    default:
      return 'Estado desconocido. Usa /registrar para comenzar.';
  }
}

/**
 * Ejecuta la inserción en Supabase y la duplicación de la plantilla.
 */
async function completarRegistro(
  chatId: number,
  state: RegistrationState
): Promise<string> {
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

  // 2. Duplicar plantilla maestra y obtener sheetId
  const { sheetId, sheetUrl } = await duplicateMasterTemplate(nombreNegocio, correo);

  // 3. Actualizar el registro con el sheet_id
  const { error: updateError } = await db
    .from('negocios')
    .update({ sheet_id: sheetId })
    .eq('id', nuevoNegocio.id);

  if (updateError) {
    // No revertimos la creación del sheet, pero informamos el error
    throw new Error(
      `Se creó la hoja de cálculo pero no se pudo guardar el ID: ${updateError.message}. Contacta al administrador con este dato: Sheet ID = ${sheetId}`
    );
  }

  // 4. Limpiar estado
  registrationStates.delete(chatId);

  // 5. Mensaje de éxito
  return (
    `✅ *¡Registro exitoso!*\n\n` +
    `Tu hoja de cálculo está lista:\n` +
    `[Ver hoja](${sheetUrl})\n\n` +
    `A partir de ahora puedes recibir pedidos.`
  );
}