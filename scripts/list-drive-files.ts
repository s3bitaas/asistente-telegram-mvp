// scripts/list-drive-files.ts
/**
 * Script de diagnóstico para listar archivos propiedad de la cuenta de servicio
 * en Google Drive, ordenados por tamaño (mayor a menor).
 *
 * Uso: npx ts-node scripts/list-drive-files.ts
 * Requiere las variables de entorno:
 *   GOOGLE_SERVICE_ACCOUNT_KEY (JSON string)
 */

import { google, drive_v3 } from 'googleapis';

// ---------------------------------------------------------------------------
// Configuración: carga de variables de entorno (agrega dotenv si es necesario)
// ---------------------------------------------------------------------------
if (process.env.NODE_ENV !== 'production') {
  // Si ejecutas localmente, puedes cargar .env con dotenv (opcional)
  try {
    require('dotenv').config();
  } catch (_) {}
}

const SERVICE_ACCOUNT_KEY = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;

if (!SERVICE_ACCOUNT_KEY) {
  console.error('❌ Falta la variable de entorno GOOGLE_SERVICE_ACCOUNT_KEY');
  console.error('   Define en un archivo .env o exporta la variable');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Autenticación con la cuenta de servicio
// ---------------------------------------------------------------------------
async function getDriveClient(): Promise<drive_v3.Drive> {
  let key: any;
  try {
    key = JSON.parse(SERVICE_ACCOUNT_KEY!);
  } catch (err) {
    console.error('❌ GOOGLE_SERVICE_ACCOUNT_KEY no contiene un JSON válido');
    process.exit(1);
  }

  const auth = new google.auth.GoogleAuth({
    credentials: key,
    scopes: ['https://www.googleapis.com/auth/drive.readonly'],
  });

  return google.drive({ version: 'v3', auth });
}

// ---------------------------------------------------------------------------
// Función principal
// ---------------------------------------------------------------------------
async function main() {
  console.log('🔍 Obteniendo archivos propiedad de la cuenta de servicio...\n');
  const drive = await getDriveClient();

  let files: drive_v3.Schema$File[] = [];
  let pageToken: string | undefined;

  // Paginación para asegurar todos los archivos
  do {
    const response = await drive.files.list({
      q: 'trashed = false', // solo archivos no eliminados
      fields: 'files(id, name, size, mimeType), nextPageToken',
      pageSize: 1000,
      pageToken,
    });

    const batch = response.data.files || [];
    files = files.concat(batch);
    pageToken = response.data.nextPageToken || undefined;
  } while (pageToken);

  if (files.length === 0) {
    console.log('No se encontraron archivos.');
    return;
  }

  // Ordenar por tamaño descendente (archivos sin tamaño al final como 0)
  files.sort((a, b) => {
    const sizeA = parseInt(a.size || '0', 10) || 0;
    const sizeB = parseInt(b.size || '0', 10) || 0;
    return sizeB - sizeA;
  });

  // Mostrar tabla
  console.log('📂 Archivos ordenados por tamaño (mayor a menor):\n');
  files.forEach((file) => {
    const name = file.name || '(sin nombre)';
    const size = file.size ? parseInt(file.size, 10) : 0;
    const sizeFormatted = formatBytes(size);
    const id = file.id || '';
    console.log(`• ${name}`);
    console.log(`  Tamaño: ${sizeFormatted} (${size} bytes)`);
    console.log(`  ID: ${id}\n`);
  });

  console.log(`Total de archivos: ${files.length}`);
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

main().catch((err) => {
  console.error('❌ Error:', err);
  process.exit(1);
});