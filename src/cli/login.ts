/**
 * Вход в аккаунт userbot'а и выдача строки сессии для TELEGRAM_SESSION.
 *
 *   npm run login
 *
 * Спрашивает телефон, код из Telegram и пароль двухэтапной проверки, если он
 * включён. Строка сессии — полный доступ к аккаунту: хранить как секрет.
 */

import { createInterface } from "node:readline/promises";
import { TelegramClient, sessions } from "teleproto";

const apiId = Number(process.env.TELEGRAM_API_ID);
const apiHash = process.env.TELEGRAM_API_HASH;
if (!apiId || !apiHash) {
  console.error("Нужны TELEGRAM_API_ID и TELEGRAM_API_HASH (https://my.telegram.org → API development tools) в .env");
  process.exit(1);
}

const rl = createInterface({ input: process.stdin, output: process.stdout });
const client = new TelegramClient(new sessions.StringSession(""), apiId, apiHash, { connectionRetries: 5 });
client.setLogLevel("error" as never);

await client.start({
  phoneNumber: () => rl.question("Телефон в международном формате (+<код страны><номер>): "),
  phoneCode: () => rl.question("Код из Telegram: "),
  password: () => rl.question("Пароль двухэтапной проверки: "),
  onError: (error) => console.error(error.message),
});

const me = await client.getMe();
console.log(`\nВошли как ${(me as { username?: string }).username ?? me.id}.`);
console.log("\nДобавьте в .env (и на сервере — в секреты):\n");
console.log(`TELEGRAM_SESSION=${client.session.save()}\n`);
rl.close();
await client.disconnect();
process.exit(0);
