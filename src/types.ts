export interface BotConfig {
  botToken: string;
  adminTelegramId: string;
}

export function loadConfig(): BotConfig {
  const botToken = process.env.BOT_TOKEN;
  if (!botToken) {
    throw new Error('Falta la variable de entorno BOT_TOKEN');
  }

  return {
    botToken,
    adminTelegramId: process.env.ADMIN_TELEGRAM_ID || '',
  };
}