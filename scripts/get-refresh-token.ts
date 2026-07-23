import { google } from 'googleapis';
import * as readline from 'readline';

const CLIENT_ID = process.env.GOOGLE_OAUTH_CLIENT_ID!;
const CLIENT_SECRET = process.env.GOOGLE_OAUTH_CLIENT_SECRET!;
const REDIRECT_URI = 'urn:ietf:wg:oauth:2.0:oob';

const oAuth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);

const authUrl = oAuth2Client.generateAuthUrl({
  access_type: 'offline',
  scope: ['https://www.googleapis.com/auth/drive', 'https://www.googleapis.com/auth/spreadsheets'],
  prompt: 'consent',
});

console.log('Abre esta URL en tu navegador, inicia sesión con la cuenta Gmail dedicada, y pega el código aquí:\n');
console.log(authUrl);

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
rl.question('\nPega el código: ', async (code) => {
  const { tokens } = await oAuth2Client.getToken(code);
  console.log('\n✅ Refresh Token:\n', tokens.refresh_token);
  rl.close();
});