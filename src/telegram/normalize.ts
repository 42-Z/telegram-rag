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
  width?: number;
  height?: number;
  spoiler?: boolean;
  ttlSeconds?: number;
  livePhoto?: boolean;
  /** Видеочасть живого фото. */
  video?: PostMedia;
  webpage?: {
    url?: string;
    displayUrl?: string;
    type?: string;
    siteName?: string;
    title?: string;
    description?: string;
    author?: string;
    embedUrl?: string;
    duration?: number;
  };
  poll?: {
    id?: string;
    question: string;
    answers: string[];
    closed?: boolean;
    publicVoters?: boolean;
    multipleChoice?: boolean;
    quiz?: boolean;
    totalVoters?: number;
    results?: Array<{ answer: string; voters?: number; correct?: boolean }>;
    solution?: string;
    closeDate?: number;
    closePeriod?: number;
  };
  geo?: {
    lat?: number;
    long?: number;
    title?: string;
    address?: string;
    provider?: string;
    venueId?: string;
    venueType?: string;
    heading?: number;
    period?: number;
    proximityNotificationRadius?: number;
  };
  audio?: { title?: string; performer?: string };
  sticker?: { alt?: string; setName?: string; mask?: boolean; customEmoji?: boolean };
  contact?: { phoneNumber: string; firstName?: string; lastName?: string; userId?: string; vcard?: string };
  dice?: { value?: number; emoticon?: string; tonAmount?: number; stakeTonAmount?: number };
  game?: { id?: string; shortName?: string; title?: string; description?: string };
  invoice?: {
    title?: string;
    description?: string;
    currency?: string;
    totalAmount?: number;
    test?: boolean;
    shippingAddressRequested?: boolean;
  };
  story?: {
    id?: number;
    peer?: { channelId?: number; userId?: number; chatId?: number };
    viaMention?: boolean;
    caption?: string;
    date?: number;
    expireDate?: number;
    mediaType?: string;
  };
  giveaway?: {
    quantity?: number;
    months?: number;
    stars?: number;
    untilDate?: number;
    prizeDescription?: string;
    channels?: string[];
    countriesIso2?: string[];
    onlyNewSubscribers?: boolean;
    winnersAreVisible?: boolean;
  };
  giveawayResults?: {
    channelId?: string;
    launchMessageId?: number;
    winnersCount?: number;
    unclaimedCount?: number;
    winners?: string[];
    months?: number;
    stars?: number;
    untilDate?: number;
    prizeDescription?: string;
  };
  paidMedia?: { starsAmount?: number; items?: Array<Record<string, unknown>> };
  todo?: {
    title?: string;
    items?: Array<{ id: number; title: string }>;
    completions?: number;
    othersCanAppend?: boolean;
    othersCanComplete?: boolean;
  };
  videoStream?: { rtmpStream?: boolean };
  /** Текст медиа, по которому пост находится поиском. */
  searchText?: string;
}

/** Медиа этих типов видны в ленте, но не участвуют в поиске. */
export const SEARCH_EXCLUDED_MEDIA_TYPES: readonly string[] = [
  "sticker",
  "custom_emoji",
  "giveaway",
  "giveaway_results",
  "paid_media",
];

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

const long = (value: unknown): string | undefined => (value === undefined || value === null ? undefined : String(value));

const flag = (value: unknown): true | undefined => (value ? true : undefined);

const stickerSetName = (stickerset: any): string | undefined => {
  if (!stickerset) return undefined;
  return stickerset.shortName ?? long(stickerset.id);
};

const peerRef = (peer: any): { channelId?: number; userId?: number; chatId?: number } | undefined => {
  if (!peer) return undefined;
  const result = { channelId: num(peer.channelId), userId: num(peer.userId), chatId: num(peer.chatId) };
  return result.channelId === undefined && result.userId === undefined && result.chatId === undefined ? undefined : result;
};

const numbered = (value: unknown): number => num(value) ?? 0;

/** Вложенный медиаобъект без служебных fileId/searchText. */
const publicMedia = (media: PostMedia): PostMedia => {
  const { fileId: _fileId, searchText: _searchText, ...rest } = media;
  return rest;
};

/** Размер по самой крупной версии фотографии. */
function photoDimensions(photo: any): { width?: number; height?: number } {
  let width: number | undefined;
  let height: number | undefined;
  for (const size of photo?.sizes ?? []) {
    const w = num(size?.w);
    const h = num(size?.h);
    if (w && h && (width === undefined || (width ?? 0) * (height ?? 0) < w * h)) {
      width = w;
      height = h;
    }
  }
  return { width, height };
}

/** Разбор документа: тип определяется по набору атрибутов, а не по первому попавшемуся. */
function describeDocument(media: any): PostMedia {
  const document = media.document;
  const attributes: any[] = document?.attributes ?? [];
  const find = (name: string) => attributes.find((attribute) => attribute?.className === name);
  const sticker = find("DocumentAttributeSticker");
  const customEmoji = find("DocumentAttributeCustomEmoji");
  const audio = find("DocumentAttributeAudio");
  const animated = find("DocumentAttributeAnimated");
  const video = find("DocumentAttributeVideo");
  const image = find("DocumentAttributeImageSize");
  const fileName = find("DocumentAttributeFilename")?.fileName;

  // Стикер и кастомный эмодзи важнее анимации и видео: у них тоже бывают
  // видео-атрибуты, но в ленте это всё равно стикер.
  const type = customEmoji
    ? "custom_emoji"
    : sticker
      ? "sticker"
      : audio
        ? audio.voice ? "voice" : "audio"
        : media.voice
          ? "voice"
          : animated
            ? "gif"
            : video || media.video || media.round
              ? video?.roundMessage || media.round ? "video_note" : "video"
              : "document";

  const result: PostMedia = {
    type,
    fileId: document?.id?.toString(),
    fileName,
    mimeType: document?.mimeType,
    duration: num(video?.duration ?? audio?.duration),
    size: num(document?.size),
    width: num(video?.w ?? image?.w),
    height: num(video?.h ?? image?.h),
    spoiler: flag(media.spoiler),
    ttlSeconds: num(media.ttlSeconds),
  };

  if (audio) {
    result.audio = { title: audio.title || undefined, performer: audio.performer || undefined };
  }
  if (sticker || customEmoji) {
    const attribute = customEmoji ?? sticker;
    result.sticker = {
      alt: attribute?.alt || undefined,
      setName: stickerSetName(attribute?.stickerset),
      mask: flag(sticker?.mask),
      customEmoji: flag(customEmoji),
    };
  }

  if (type !== "sticker" && type !== "custom_emoji") {
    const searchText = [fileName, audio?.title, audio?.performer].filter(Boolean).join(" ");
    if (searchText) result.searchText = searchText;
  }
  return result;
}

export function describeMedia(media: any): PostMedia | null {
  if (!media) return null;
  switch (media.className) {
    case "MessageMediaEmpty":
    case undefined:
      return null;
    case "MessageMediaPhoto": {
      const { width, height } = photoDimensions(media.photo);
      const result: PostMedia = {
        type: "photo",
        fileId: media.photo?.id?.toString(),
        width,
        height,
        spoiler: flag(media.spoiler),
        ttlSeconds: num(media.ttlSeconds),
        livePhoto: flag(media.livePhoto),
      };
      if (media.video) {
        const video = describeMedia({
          className: "MessageMediaDocument",
          document: media.video,
        });
        if (video) result.video = publicMedia(video);
      }
      return result;
    }
    case "MessageMediaDocument":
      return describeDocument(media);
    case "MessageMediaWebPage": {
      const page = media.webpage;
      if (!page || page.className !== "WebPage") return { type: "webpage", webpage: { url: page?.url } };
      const webpage = {
        url: page.url,
        displayUrl: page.displayUrl,
        type: page.type,
        siteName: page.siteName,
        title: page.title,
        description: page.description,
        author: page.author,
        embedUrl: page.embedUrl,
        duration: num(page.duration),
      };
      return {
        type: "webpage",
        webpage,
        searchText: [webpage.siteName, webpage.title, webpage.description, webpage.author].filter(Boolean).join("\n") || undefined,
      };
    }
    case "MessageMediaPoll": {
      const poll = media.poll;
      const results = media.results;
      const question = plain(poll?.question);
      const answers = (poll?.answers ?? []).map((answer: any) => plain(answer?.text));
      const rows = (results?.results ?? []).map((row: any, index: number) => ({
        answer: answers[index] ?? "",
        voters: num(row?.voters),
        correct: row?.correct || undefined,
      }));
      return {
        type: "poll",
        poll: {
          id: long(poll?.id),
          question,
          answers,
          closed: flag(poll?.closed),
          publicVoters: flag(poll?.publicVoters),
          multipleChoice: flag(poll?.multipleChoice),
          quiz: flag(poll?.quiz),
          totalVoters: num(results?.totalVoters),
          results: rows.length > 0 ? rows : undefined,
          solution: results?.solution || undefined,
          closeDate: num(poll?.closeDate),
          closePeriod: num(poll?.closePeriod),
        },
        searchText: [question, ...answers, results?.solution].filter(Boolean).join("\n") || undefined,
      };
    }
    case "MessageMediaGeo":
    case "MessageMediaVenue":
    case "MessageMediaGeoLive": {
      const geo = media.geo;
      const type = media.className === "MessageMediaVenue"
        ? "venue"
        : media.className === "MessageMediaGeoLive" ? "geo_live" : "geo";
      const data = {
        lat: num(geo?.lat),
        long: num(geo?.long),
        title: media.title || undefined,
        address: media.address || undefined,
        provider: media.provider || undefined,
        venueId: media.venueId || undefined,
        venueType: media.venueType || undefined,
        heading: num(media.heading),
        period: num(media.period),
        proximityNotificationRadius: num(media.proximityNotificationRadius),
      };
      return {
        type,
        geo: data,
        searchText: [data.title, data.address, data.provider].filter(Boolean).join(" ") || undefined,
      };
    }
    case "MessageMediaContact":
      return {
        type: "contact",
        contact: {
          phoneNumber: media.phoneNumber ?? "",
          firstName: media.firstName || undefined,
          lastName: media.lastName || undefined,
          userId: long(media.userId),
          vcard: media.vcard || undefined,
        },
        searchText: [media.firstName, media.lastName, media.phoneNumber].filter(Boolean).join(" ") || undefined,
      };
    case "MessageMediaGame":
      return {
        type: "game",
        game: {
          id: long(media.game?.id),
          shortName: media.game?.shortName || undefined,
          title: media.game?.title || undefined,
          description: media.game?.description || undefined,
        },
        searchText: [media.game?.title, media.game?.description].filter(Boolean).join("\n") || undefined,
      };
    case "MessageMediaInvoice":
      return {
        type: "invoice",
        invoice: {
          title: media.title || undefined,
          description: media.description || undefined,
          currency: media.currency || undefined,
          totalAmount: num(media.totalAmount),
          test: flag(media.test),
          shippingAddressRequested: flag(media.shippingAddressRequested),
        },
        searchText: [media.title, media.description].filter(Boolean).join("\n") || undefined,
      };
    case "MessageMediaDice":
      return {
        type: "dice",
        dice: {
          value: num(media.value),
          emoticon: media.emoticon || undefined,
          tonAmount: num(media.gameOutcome?.tonAmount),
          stakeTonAmount: num(media.gameOutcome?.stakeTonAmount),
        },
      };
    case "MessageMediaStory": {
      const story = media.story;
      return {
        type: "story",
        story: {
          id: num(media.id),
          peer: peerRef(media.peer ?? story?.fromId),
          viaMention: flag(media.viaMention),
          caption: story?.caption || undefined,
          date: num(story?.date),
          expireDate: num(story?.expireDate),
          mediaType: story?.media ? describeMedia(story.media)?.type : undefined,
        },
        searchText: story?.caption || undefined,
      };
    }
    case "MessageMediaGiveaway":
      return {
        type: "giveaway",
        giveaway: {
          quantity: num(media.quantity),
          months: num(media.months),
          stars: num(media.stars),
          untilDate: num(media.untilDate),
          prizeDescription: media.prizeDescription || undefined,
          channels: (media.channels ?? []).map(String),
          countriesIso2: media.countriesIso2,
          onlyNewSubscribers: flag(media.onlyNewSubscribers),
          winnersAreVisible: flag(media.winnersAreVisible),
        },
      };
    case "MessageMediaGiveawayResults":
      return {
        type: "giveaway_results",
        giveawayResults: {
          channelId: long(media.channelId),
          launchMessageId: num(media.launchMsgId),
          winnersCount: num(media.winnersCount),
          unclaimedCount: num(media.unclaimedCount),
          winners: (media.winners ?? []).map(String),
          months: num(media.months),
          stars: num(media.stars),
          untilDate: num(media.untilDate),
          prizeDescription: media.prizeDescription || undefined,
        },
      };
    case "MessageMediaPaidMedia":
      return {
        type: "paid_media",
        paidMedia: {
          starsAmount: num(media.starsAmount),
          items: (media.extendedMedia ?? []).map((item: any) => {
            if (item?.className === "MessageExtendedMediaPreview") {
              return {
                preview: true,
                width: num(item.w),
                height: num(item.h),
                duration: num(item.videoDuration),
              };
            }
            if (item?.media) {
              const described = describeMedia(item.media);
              if (described) return publicMedia(described);
            }
            return { type: "unknown" };
          }),
        },
      };
    case "MessageMediaToDo": {
      const todo = media.todo;
      const title = plain(todo?.title);
      const items: Array<{ id: number; title: string }> = (todo?.list ?? []).map((item: any) => ({
        id: numbered(item?.id),
        title: plain(item?.title),
      }));
      return {
        type: "todo",
        todo: {
          title: title || undefined,
          items,
          completions: (media.completions ?? []).length,
          othersCanAppend: flag(todo?.othersCanAppend),
          othersCanComplete: flag(todo?.othersCanComplete),
        },
        searchText: [title, ...items.map((item) => item.title)].filter(Boolean).join("\n") || undefined,
      };
    }
    case "MessageMediaVideoStream":
      return {
        type: "video_stream",
        videoStream: { rtmpStream: flag(media.rtmpStream) },
      };
    case "MessageMediaUnsupported":
      return { type: "unsupported" };
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

/** Исходный текст и метаданные Telegram; generated media analysis не включается. */
export function searchableText(post: Pick<PostRecord, "text" | "media">): string {
  return [post.text, post.media?.searchText].filter(Boolean).join("\n\n").trim();
}

export function hashContent(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 32);
}

/** Stable attachment identity fallback for Telegram media without a file id. */
export function mediaSourceFingerprint(media: PostMedia | null | undefined): string {
  const identity = media
    ? {
        type: media.type,
        fileId: media.fileId ?? null,
        fileName: media.fileName ?? null,
        mimeType: media.mimeType ?? null,
        size: media.size ?? null,
        duration: media.duration ?? null,
      }
    : null;
  return createHash("sha256").update(JSON.stringify(identity)).digest("hex");
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
