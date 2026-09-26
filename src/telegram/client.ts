/**
 * Клиент userbot'а на teleproto и приведение ссылок на канал к сущности.
 */

import bigInt from "big-integer";
import { Api, TelegramClient, sessions } from "teleproto";

export interface TelegramConfig {
  apiId: number;
  apiHash: string;
  session: string;
}

export function createClient(config: TelegramConfig): TelegramClient {
  const client = new TelegramClient(new sessions.StringSession(config.session), config.apiId, config.apiHash, {
    connectionRetries: Number.POSITIVE_INFINITY,
    autoReconnect: true,
    // FloodWait до пяти минут библиотека пережидает сама, без ошибки.
    floodSleepThreshold: 300,
  });
  client.setLogLevel("error" as never);
  return client;
}

export interface ResolvedChannel {
  id: number;
  username: string | null;
  title: string;
  about: string | null;
  accessHash: string | null;
  peer: Api.InputPeerChannel;
}

const INVITE = /(?:t(?:elegram)?\.me\/(?:\+|joinchat\/))([\w-]+)/i;

/** Пользовательская запись канала → @имя, приглашение или числовой id. */
export function parseChannelRef(ref: string): { kind: "username"; value: string } | { kind: "invite"; hash: string } | { kind: "id"; id: number } {
  const value = ref.trim();
  const invite = value.match(INVITE);
  if (invite) return { kind: "invite", hash: invite[1]! };
  if (/^-?\d+$/.test(value)) return { kind: "id", id: Number(value.replace(/^-100/, "")) };
  const username = value
    .replace(/^https?:\/\//i, "")
    .replace(/^(t|telegram)\.me\//i, "")
    .replace(/^s\//, "")
    .replace(/^@/, "")
    .split(/[/?#]/)[0]!;
  if (!/^[A-Za-z][\w]{3,}$/.test(username)) throw new Error(`не похоже на канал: «${ref}»`);
  return { kind: "username", value: username };
}

function fromEntity(entity: unknown): Omit<ResolvedChannel, "about"> {
  if (!(entity instanceof Api.Channel)) {
    throw new Error("это не канал и не супергруппа: обычные чаты, пользователи и боты не поддерживаются");
  }
  const username = entity.username ?? entity.usernames?.find((item) => item.active)?.username ?? null;
  const accessHash = entity.accessHash ? entity.accessHash.toString() : null;
  return {
    id: Number(entity.id.toString()),
    username,
    title: entity.title,
    accessHash,
    peer: new Api.InputPeerChannel({ channelId: entity.id, accessHash: entity.accessHash ?? bigInt.zero }),
  };
}

async function about(client: TelegramClient, peer: Api.InputPeerChannel): Promise<string | null> {
  try {
    const full = await client.invoke(
      new Api.channels.GetFullChannel({ channel: new Api.InputChannel({ channelId: peer.channelId, accessHash: peer.accessHash }) }),
    );
    return (full.fullChat as Api.ChannelFull).about || null;
  } catch {
    return null;
  }
}

/**
 * Находит канал. Публичный — по имени, читать можно без вступления.
 * Закрытый — по приглашению: аккаунт вступает в него (иначе Telegram не
 * отдаёт историю). Уже известный — по id и сохранённому access hash.
 */
export async function resolveChannel(
  client: TelegramClient,
  ref: string,
  known?: { id: number; accessHash: string | null; username: string | null },
): Promise<ResolvedChannel> {
  let entity: unknown;
  if (known?.username) {
    entity = await client.getEntity(known.username);
  } else if (known?.accessHash) {
    const peer = new Api.InputPeerChannel({ channelId: bigInt(known.id), accessHash: bigInt(known.accessHash) });
    entity = await client.getEntity(peer);
  } else {
    const parsed = parseChannelRef(ref);
    if (parsed.kind === "username") {
      entity = await client.getEntity(parsed.value);
    } else if (parsed.kind === "id") {
      entity = await client.getEntity(new Api.PeerChannel({ channelId: bigInt(parsed.id) }));
    } else {
      const check = await client.invoke(new Api.messages.CheckChatInvite({ hash: parsed.hash }));
      if (check instanceof Api.ChatInviteAlready || check instanceof Api.ChatInvitePeek) {
        entity = check.chat;
      } else {
        const joined = await client.invoke(new Api.messages.ImportChatInvite({ hash: parsed.hash }));
        entity = "chats" in joined ? (joined.chats as unknown[])[0] : undefined;
      }
    }
  }
  const channel = fromEntity(entity);
  return { ...channel, about: await about(client, channel.peer) };
}
