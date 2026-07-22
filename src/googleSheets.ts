// src/googleSheets.ts
import { google, sheets_v4, drive_v3 } from 'googleapis';
import type { MenuItem } from './orderParser';

// ---------------------------------------------------------------------------
// Tipos
// ---------------------------------------------------------------------------

interface DrivePermissionResponse {
  id: string;
  type: string;
  role: string;
}

interface SheetCacheEntry {
  menu: MenuItem[];
  timestamp: number;
}

// ---------------------------------------------------------------------------
// Configuración
// ---------------------------------------------------------------------------

const MASTER_TEMPLATE_ID = process.env.MASTER_TEMPLATE_ID;
if (!MASTER_TEMPLATE_ID) {
  throw new Error('Falta variable de entorno MASTER_TEMPLATE_ID');
}

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutos

// ---------------------------------------------------------------------------
// Caché en memoria (por proceso serverless, la función puede escalar)
// ---------------------------------------------------------------------------

const menuCache = new Map<string, SheetCacheEntry>();

// ---------------------------------------------------------------------------
// Autenticación con Service Account
// ---------------------------------------------------------------------------

function getAuthClient() {
  const keyString = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  if (!keyString) {
    throw new Error('Falta variable de entorno GOOGLE_SERVICE_ACCOUNT_KEY');
  }

  let key: Record<string, any>;
  try {
    key = JSON.parse(keyString);
  } catch (err) {
    throw new Error(`GOOGLE_SERVICE_ACCOUNT_KEY no es JSON válido: ${err}`);
  }

  return new google.auth.GoogleAuth({
    credentials: key,
    scopes: [
      'https://www.googleapis.com/auth/drive',
      'https://www.googleapis.com/auth/spreadsheets',
    ],
  });
}

// ---------------------------------------------------------------------------
// Reintentos con backoff exponencial
// ---------------------------------------------------------------------------

async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  maxRetries = 3,
  baseDelay = 1000
): Promise<T> {
  let lastError: Error | undefined;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      lastError = err;
      // 429 = rate limit, 5xx = error del servidor
      if (
        err?.code === 429 ||
        (err?.code && err.code >= 500 && err.code < 600) ||
        err?.response?.status === 429 ||
        (err?.response?.status && err.response.status >= 500 && err.response.status < 600)
      ) {
        if (attempt < maxRetries) {
          const delay = baseDelay * Math.pow(2, attempt);
          console.log(`Reintento ${attempt + 1}/${maxRetries} en ${delay}ms…`);
          await new Promise((resolve) => setTimeout(resolve, delay));
          continue;
        }
      }
      throw err; // Si no es reintentable o se acabaron los intentos
    }
  }
  throw lastError; // Solo se alcanza si todos los intentos fallan
}

// ---------------------------------------------------------------------------
// Google Drive: duplicar plantilla maestra
// ---------------------------------------------------------------------------

export async function duplicateMasterTemplate(
  nombreNegocio: string,
  emailCliente: string
): Promise<{ sheetId: string; sheetUrl: string }> {
  const auth = getAuthClient();
  const drive: drive_v3.Drive = google.drive({ version: 'v3', auth });

  // 1. Copiar el archivo
  const copyResponse = await retryWithBackoff(() =>
    drive.files.copy({
      fileId: MASTER_TEMPLATE_ID,
      requestBody: {
        name: `Copia_${nombreNegocio}`,
      },
    })
  );

  const newFileId = copyResponse.data.id;
  if (!newFileId) {
    throw new Error('No se obtuvo ID al copiar la plantilla');
  }

  // 2. Dar permiso de editor al cliente
  await retryWithBackoff(() =>
    drive.permissions.create({
      fileId: newFileId,
      requestBody: {
        type: 'user',
        role: 'writer',
        emailAddress: emailCliente,
      },
      sendNotificationEmail: false, // no enviar correo automático
    })
  );

  // 3. Devolver ID y URL
  const sheetUrl = `https://docs.google.com/spreadsheets/d/${newFileId}`;
  return { sheetId: newFileId, sheetUrl };
}

// ---------------------------------------------------------------------------
// Leer pestaña "Menú" de un Sheet → MenuItem[] (con caché de proceso)
// ---------------------------------------------------------------------------

export async function writeMenuTab(sheetId: string): Promise<MenuItem[]> {
  // Verificar caché
  const cached = menuCache.get(sheetId);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return cached.menu;
  }

  const auth = getAuthClient();
  const sheets: sheets_v4.Sheets = google.sheets({ version: 'v4', auth });

  // Leer rango completo de la pestaña "Menú" (columnas A a D)
  const response = await retryWithBackoff(() =>
    sheets.spreadsheets.values.get({
      spreadsheetId: sheetId,
      range: 'Menú!A:D', // Columna A: nombre, B: tipo, C: precio, D: sinónimos (separados por coma)
    })
  );

  const rows = response.data.values;
  if (!rows || rows.length === 0) {
    throw new Error('La pestaña "Menú" está vacía o no existe');
  }

  const menu: MenuItem[] = [];
  for (let i = 0; i < rows.length; i++) {
    const [nombre, tipo, precioRaw, sinonimosRaw] = rows[i];
    if (!nombre || !tipo) continue; // saltar filas vacías

    // Validar tipo
    if (tipo !== 'base' && tipo !== 'extra') {
      console.warn(`Tipo inválido en fila ${i + 1}: ${tipo}, se omite`);
      continue;
    }

    const precio = parseFloat(precioRaw);
    if (isNaN(precio)) {
      console.warn(`Precio inválido en fila ${i + 1}: ${precioRaw}, se omite`);
      continue;
    }

    const sinonimos = sinonimosRaw
      ? sinonimosRaw
          .split(',')
          .map((s: string) => s.trim())
          .filter((s: string) => s.length > 0)
      : [];

    menu.push({ nombre: nombre.trim(), tipo, precio, sinonimos });
  }

  // Guardar en caché
  menuCache.set(sheetId, { menu, timestamp: Date.now() });

  return menu;
}

// ---------------------------------------------------------------------------
// Escribir todas las órdenes del día en pestaña "Ventas" (append en batch)
// ---------------------------------------------------------------------------

export async function batchWriteSales(
  sheetId: string,
  pedidos: ParsedOrder[]
): Promise<void> {
  if (pedidos.length === 0) return;

  const auth = getAuthClient();
  const sheets: sheets_v4.Sheets = google.sheets({ version: 'v4', auth });

  // Formatear filas: cada fila -> [timestamp, producto, cantidad, extras, precio_total]
  const now = new Date().toISOString();
  const rows = pedidos.flatMap((pedido) =>
    pedido.items.map((item) => [
      now,                         // A: timestamp
      item.producto,               // B: producto
      item.cantidad,               // C: cantidad
      item.extras.join(', '),      // D: extras (separados por coma)
      item.precio_total.toFixed(2),// E: total (con 2 decimales)
    ])
  );

  await retryWithBackoff(() =>
    sheets.spreadsheets.values.append({
      spreadsheetId: sheetId,
      range: 'Ventas!A:E',
      valueInputOption: 'USER_ENTERED', // respeta formatos (número, fecha)
      insertDataOption: 'INSERT_ROWS',
      requestBody: {
        values: rows,
      },
    })
  );
}