// Скрипт обхода очереди напоминаний.
// Реальную отправку (WhatsApp/SMS/Telegram) подключите вместо `console.log` ниже.
import { dueReminders, markReminder } from "../src/services/reminderService.js";

async function main() {
  const due = await dueReminders();
  if (!due.length) {
    console.log("Нет напоминаний к отправке.");
    return;
  }
  console.log(`Найдено ${due.length} напоминаний к отправке.`);
  for (const reminder of due) {
    try {
      // TODO: подключить реального провайдера (WhatsApp Business API / Wazzup / Twilio / Telegram bot).
      console.log(`[${reminder.channel}] → ${reminder.phone}: ${reminder.payload.text}`);
      await markReminder(reminder.id, "sent");
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown";
      await markReminder(reminder.id, "failed", message);
      console.error(`Ошибка для ${reminder.id}: ${message}`);
    }
  }
}

await main();
