import "dotenv/config";

export const config = {
  projectId: process.env.GCP_PROJECT_ID,
  region: process.env.GCP_REGION || "us-central1",
  telegramToken: process.env.TELEGRAM_BOT_TOKEN,
  telegramChatId: process.env.TELEGRAM_CHAT_ID,
  whatsappToken: process.env.WHATSAPP_TOKEN,
  whatsappPhoneId: process.env.WHATSAPP_PHONE_ID,
  gmailUser: process.env.GMAIL_USER,
  port: process.env.PORT || 8080,
};

if (!config.projectId) {
  console.warn(
    "GCP_PROJECT_ID is not set. Copy .env.example to .env and fill it in before running an agent."
  );
}
