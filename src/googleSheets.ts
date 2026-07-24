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
// Autenticación con OAuth2 (cuenta Gmail dedicada)
// ---------------------------------------------------------------------------

function getAuthClient() {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  const refreshToken = process.env.GOOGLE_OAUTH_REFRESH_TOKEN;
  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error(
      'Faltan variables de entorno GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET o GOOGLE_OAUTH_REFRESH_TOKEN'
    );
  }
  const oauth2Client = new google.auth.OAuth2(
    clientId,
    clientSecret,
    'https://developers.google.com/oauthplayground'
  );
  oauth2Client.setCredentials({
    refresh_token: refreshToken,
  });
  return oauth2Client;
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
      throw err;
    }
  }
  throw lastError;
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

  await retryWithBackoff(() =>
    drive.permissions.create({
      fileId: newFileId,
      requestBody: {
        type: 'user',
        role: 'writer',
        emailAddress: emailCliente,
      },
      sendNotificationEmail: true, // ← cambiado a true para compartir con cuentas que no son Google
    })
  );

  const sheetUrl = `https://docs.google.com/spreadsheets/d/${newFileId}`;
  return { sheetId: newFileId, sheetUrl };
}

// ---------------------------------------------------------------------------
// Leer pestaña "Menú" de un Sheet → MenuItem[] (con caché de proceso)
// ---------------------------------------------------------------------------

export async function writeMenuTab(sheetId: string): Promise<MenuItem[]> {
  const cached = menuCache.get(sheetId);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return cached.menu;
  }

  const auth = getAuthClient();
  const sheets: sheets_v4.Sheets = google.sheets({ version: 'v4', auth });

  const response = await retryWithBackoff(() =>
    sheets.spreadsheets.values.get({
      spreadsheetId: sheetId,
      range: 'Menú!A:D',
    })
  );

  const rows = response.data.values;
  if (!rows || rows.length === 0) {
    throw new Error('La pestaña "Menú" está vacía o no existe');
  }

  const menu: MenuItem[] = [];
  for (let i = 0; i < rows.length; i++) {
    const [nombre, tipo, precioRaw, sinonimosRaw] = rows[i];
    if (!nombre || !tipo) continue;

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

  const now = new Date().toISOString();
  const rows = pedidos.flatMap((pedido) =>
    pedido.items.map((item) => [
      now,
      item.producto,
      item.cantidad,
      item.extras.join(', '),
      item.precio_total.toFixed(2),
    ])
  );

  await retryWithBackoff(() =>
    sheets.spreadsheets.values.append({
      spreadsheetId: sheetId,
      range: 'Ventas!A:E',
      valueInputOption: 'USER_ENTERED',
      insertDataOption: 'INSERT_ROWS',
      requestBody: {
        values: rows,
      },
    })
  );
}