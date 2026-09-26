/**
 * Сообщение MTProto → запись поста. Функция чистая и не знает о клиенте:
 * на вход — объект с полями Api.Message, на выход — то, что ляжет в базу.
 *
 * В пост попадает всё, что несёт смысл для ассистента: текст с разметкой
 * (ссылки, спрятанные в словах, иначе теряются), описание медиа — превью
 * ссылки, опрос, имя и тип файла, — пересылка, реакции, просмотры.
 */

import { createHash } from "node:crypto";

export interface PostMedia {
  type: string;
  /** Идентификатор файла в Telegram: по нему видно, что при правке медиа заменили. */
  fileId?: string;
  fileName?: string;
  mimeType?: string;
  duration?: number;
  size?: number;
  webpage?: { url?: string; siteName?: string; title?: string; description?: string };
  poll?: { question: string; answers: string[]; closed?: boolean; totalVoters?: number };
  geo?: { lat: number; long: number; title?: string; address?: string };
  /** Текст медиа, по которому пост находится поиском. */
  searchText?: string;
}

export interface PostRecord {
  channelId: number;
  messageId: number;
  date: Date;
  editDate: Date | null;
  text: string;
  media: PostMedia | null;
  groupedId: string | null;
  views: number | null;
  forwards: number | null;
  replies: number | null;
  reactions: Array<{ reaction: string; count: number }> | null;
  replyTo: number | null;
  forwardedFrom: { name?: string; channelId?: number; messageId?: number; date?: Date } | null;
  postAuthor: string | null;
  contentHash: string;
}

/** Поля Api.Message, которыми пользуется разбор. */
export interface MessageLike {
  className?: string;
  id: number;
  date?: number;
  editDate?: number;
  message?: string;
  /** Текст с разметкой (Markdown) — геттер пользовательского Message в teleproto. */
  text?: string;
  media?: any;
  groupedId?: { toString(): string } | null;
  views?: number;
  forwards?: number;
  replies?: { replies?: number } | null;
  reactions?: { results?: Array<{ reaction?: any; count?: number }> } | null;
  replyTo?: { replyToMsgId?: number } | null;
  fwdFrom?: any;
  postAuthor?: string;
  action?: unknown;
}

const plain = (value: unknown): string => {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && "text" in value) return String((value as { text: unknown }).text ?? "");
  return "";
};

const num = (value: unknown): number | undefined => {
  if (value === undefined || value === null) return undefined;
  const result = Number(typeof value === "object" ? String(value) : value);
  return Number.isFinite(result) ? result : undefined;
};

function documentType(document: any): string {
  const attributes: any[] = document?.attributes ?? [];
  for (const attribute of attributes) {
    switch (attribute?.className) {
      case "DocumentAttributeVideo":
        return attribute.roundMessage ? "video_note" : "video";
      case "DocumentAttributeAudio":
        return attribute.voice ? "voice" : "audio";
      case "DocumentAttributeSticker":
        return "sticker";
      case "DocumentAttributeAnimated":
        return "gif";
    }
  }
  return "document";
}

export function describeMedia(media: any): PostMedia | null {
  if (!media) return null;
  switch (media.className) {
    case "MessageMediaEmpty":
    case undefined:
      return null;
    case "MessageMediaPhoto":
      return { type: "photo", fileId: media.photo?.id?.toString() };
    case "MessageMediaDocument": {
      const document = media.document;
      const attributes: any[] = document?.attributes ?? [];
      const fileName = attributes.find((a) => a?.className === "DocumentAttributeFilename")?.fileName;
      const timed = attributes.find((a) => a?.duration !== undefined);
      const audio = attributes.find((a) => a?.className === "DocumentAttributeAudio");
      const result: PostMedia = {
        type: documentType(document),
        fileId: document?.id?.toString(),
        fileName,
        mimeType: document?.mimeType,
        duration: num(timed?.duration),
        size: num(document?.size),
      };
      const searchText = [fileName, audio?.title, audio?.performer].filter(Boolean).join(" ");
      if (searchText) result.searchText = searchText;
      return result;
    }
    case "MessageMediaWebPage": {
      const page = media.webpage;
      if (!page || page.className !== "WebPage") return { type: "webpage", webpage: { url: page?.url } };
      const webpage = {
        url: page.url,
        siteName: page.siteName,
        title: page.title,
        description: page.description,
      };
      return {
        type: "webpage",
        webpage,
        searchText: [webpage.siteName, webpage.title, webpage.description].filter(Boolean).join("\n"),
      };
    }
    case "MessageMediaPoll": {
      const poll = media.poll;
      const question = plain(poll?.question);
      const answers = (poll?.answers ?? []).map((answer: any) => plain(answer?.text));
      return {
        type: "poll",
        poll: { question, answers, closed: poll?.closed, totalVoters: media.results?.totalVoters },
        searchText: [question, ...answers].join("\n"),
      };
    }
    case "MessageMediaGeo":
    case "MessageMediaVenue":
    case "MessageMediaGeoLive": {
      const geo = media.geo;
      return {
        type: "geo",
        geo: { lat: geo?.lat, long: geo?.long, title: media.title, address: media.address },
        searchText: [media.title, media.address].filter(Boolean).join(" ") || undefined,
      };
    }
    default:
      return { type: String(media.className).replace(/^MessageMedia/, "").toLowerCase() };
  }
}

function reactionLabel(reaction: any): string {
  if (reaction?.className === "ReactionEmoji") return reaction.emoticon;
  if (reaction?.className === "ReactionCustomEmoji") return `custom:${String(reaction.documentId)}`;
  if (reaction?.className === "ReactionPaid") return "⭐";
  return "?";
}

/** Текст, по которому строятся эмбеддинги и отпечаток поста. */
export function searchableText(post: Pick<PostRecord, "text" | "media"> & { mediaText?: string | null }): string {
  return [post.text, post.media?.searchText, post.mediaText].filter(Boolean).join("\n\n").trim();
}

export function hashContent(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 32);
}

/** Служебные сообщения (закреп, смена названия…) постами не считаются. */
export function isPost(message: MessageLike): boolean {
  return message.className !== "MessageService" && message.className !== "MessageEmpty" && !message.action;
}

/**
 * Соседние куски одного оформления teleproto размечает встык: «**a****, ****b**»
 * вместо «**a, b**». Пустые пары маркеров смысла не несут и мешают поиску.
 */
export function tidyMarkdown(text: string): string {
  // пары одинаковых маркеров и сочетания жирного с курсивом: «****», «**__**__»
  return text.replace(/(\*\*__|__\*\*|\*\*|__|~~)\1/g, "");
}

export function normalizeMessage(channelId: number, message: MessageLike): PostRecord {
  let text = message.message ?? "";
  try {
    // Markdown сохраняет ссылки, спрятанные в словах; сырой текст — нет.
    if (typeof message.text === "string" && message.text.length > 0) text = tidyMarkdown(message.text);
  } catch {
    // геттер разметки может упасть на экзотических сущностях — остаётся сырой текст
  }
  const media = describeMedia(message.media);
  const fwd = message.fwdFrom;
  const forwardedFrom = fwd
    ? {
        name: fwd.fromName ?? fwd.postAuthor ?? undefined,
        channelId: num(fwd.fromId?.channelId),
        messageId: num(fwd.channelPost),
        date: fwd.date ? new Date(fwd.date * 1000) : undefined,
      }
    : null;
  const reactions =
    message.reactions?.results?.map((item) => ({ reaction: reactionLabel(item.reaction), count: item.count ?? 0 })) ??
    null;

  const record: Omit<PostRecord, "contentHash"> = {
    channelId,
    messageId: message.id,
    date: new Date((message.date ?? 0) * 1000),
    editDate: message.editDate ? new Date(message.editDate * 1000) : null,
    text,
    media,
    groupedId: message.groupedId ? message.groupedId.toString() : null,
    views: message.views ?? null,
    forwards: message.forwards ?? null,
    replies: message.replies?.replies ?? null,
    reactions: reactions && reactions.length > 0 ? reactions : null,
    replyTo: message.replyTo?.replyToMsgId ?? null,
    forwardedFrom,
    postAuthor: message.postAuthor ?? null,
  };
  return { ...record, contentHash: hashContent(searchableText(record)) };
}

export function postLink(channel: { id: number; username: string | null }, messageId: number): string {
  return channel.username
    ? `https://t.me/${channel.username}/${messageId}`
    : `https://t.me/c/${channel.id}/${messageId}`;
}
