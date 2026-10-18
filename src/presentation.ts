import type { ObjectStorage } from "./storage.ts";
import type { MediaAsset, Post, Store } from "./store.ts";

const DOWNLOADABLE_TYPES = new Set(["photo", "voice", "video_note", "audio", "video", "gif"]);

export interface MediaLinkResource {
  type: "resource_link";
  uri: string;
  name: string;
  mimeType: string;
  description: string;
}

export type MediaPresentation = Record<string, unknown>;

export const postKey = (post: Pick<Post, "channelId" | "messageId">): string =>
  `${post.channelId}:${post.messageId}`;

function displayFileName(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  const safe = value.replace(/[\u0000-\u001f\u007f]/g, "_").slice(0, 255);
  return safe || undefined;
}

function clean<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function sourceMedia(media: NonNullable<Post["media"]>): MediaPresentation {
  const { fileId: _fileId, searchText: _searchText, fileName, mimeType, ...source } = media;
  return {
    ...source,
    ...(fileName ? { file_name: fileName } : {}),
    ...(mimeType ? { mime_type: mimeType } : {}),
  };
}

async function presentMedia(
  post: Post,
  asset: MediaAsset | undefined,
  storage: ObjectStorage | undefined,
  signed: Map<string, Promise<{ url: string; expiresAt: Date }>>,
): Promise<MediaPresentation | undefined> {
  const media = post.media;
  if (!media) return undefined;
  const view = sourceMedia(media);
  if (!DOWNLOADABLE_TYPES.has(media.type)) return view;

  Object.assign(view, {
    file_name: displayFileName(asset?.fileName ?? media.fileName),
    mime_type: asset?.mimeType ?? media.mimeType,
    size: asset?.size ?? media.size,
    duration: asset?.duration ?? media.duration,
    storage_status: asset?.storageStatus ?? "pending",
    storage_error: asset?.storageError ?? undefined,
    embedding_status: asset?.embeddingStatus ?? "pending",
    embedding_error: asset?.embeddingError ?? undefined,
  });

  if (!asset || asset.storageStatus !== "stored" || !asset.objectKey) {
    if (!asset) view.download_error = "оригинал ещё не сохранён в объектное хранилище";
    else if (asset.storageStatus === "pending") view.download_error = "оригинал ожидает сохранения в объектное хранилище";
    else if (asset.storageStatus === "failed" || asset.storageStatus === "skipped") {
      view.download_error = asset.storageError ?? "оригинал недоступен для скачивания";
    }
    else view.download_error = "у сохранённого объекта нет ключа для скачивания";
    return clean(view);
  }
  if (!storage) {
    view.download_error = "объектное хранилище не настроено для выдачи ссылки";
    return clean(view);
  }
  if (asset.bucket !== storage.bucket) {
    view.download_error = "bucket сохранённого объекта не совпадает с текущей конфигурацией";
    return clean(view);
  }

  const cacheKey = `${asset.bucket}:${asset.objectKey}`;
  let url = signed.get(cacheKey);
  if (!url) {
    url = storage.signGet(asset.objectKey);
    signed.set(cacheKey, url);
  }
  try {
    const result = await url;
    view.url = result.url;
    view.expires_at = result.expiresAt.toISOString();
  } catch {
    view.download_error = "не удалось создать временную прямую ссылку на объект";
  }
  return clean(view);
}

/** Prepare asset metadata in one batch and sign each distinct object at most once. */
export async function presentPostMedia(
  posts: readonly Post[],
  store: Pick<Store, "getMediaAssetsForPosts">,
  storage?: ObjectStorage,
): Promise<Map<string, MediaPresentation | undefined>> {
  const assets = await store.getMediaAssetsForPosts(posts);
  const byPost = new Map(assets.map((asset) => [postKey(asset), asset]));
  const signed = new Map<string, Promise<{ url: string; expiresAt: Date }>>();
  const result = new Map<string, MediaPresentation | undefined>();
  for (const post of posts) {
    const key = postKey(post);
    if (result.has(key)) continue;
    result.set(key, await presentMedia(post, byPost.get(key), storage, signed));
  }
  return result;
}

/** The shared, generated-analysis-free post DTO used by REST and MCP. */
export function presentPost(
  post: Post,
  media: MediaPresentation | undefined,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  const view = {
    channel: post.channel,
    channel_username: post.channelUsername ?? undefined,
    channel_id: post.channelId,
    message_id: post.messageId,
    link: post.link,
    date: post.date.toISOString(),
    edited: post.editDate?.toISOString(),
    author: post.postAuthor ?? undefined,
    text: post.text,
    media,
    views: post.views ?? undefined,
    forwards: post.forwards ?? undefined,
    comments: post.replies ?? undefined,
    reactions: post.reactions ?? undefined,
    reply_to_message_id: post.replyTo ?? undefined,
    forwarded_from: post.forwardedFrom ?? undefined,
    deleted: post.deleted || undefined,
    ...extra,
  };
  return clean(view);
}

/** Traverse only the known tool DTO structure; never scan arbitrary post text for URLs. */
export function collectMediaResourceLinks(result: unknown): MediaLinkResource[] {
  const links = new Map<string, MediaLinkResource>();
  const visited = new Set<object>();

  const visit = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    if (visited.has(value)) return;
    visited.add(value);
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }

    const object = value as Record<string, unknown>;
    const media = object.media && typeof object.media === "object" ? object.media as Record<string, unknown> : undefined;
    if (
      typeof object.message_id === "number" &&
      media &&
      typeof media.url === "string" &&
      typeof media.mime_type === "string"
    ) {
      const uri = media.url;
      const name = typeof media.file_name === "string" ? media.file_name : `message-${object.message_id}`;
      const size = typeof media.size === "number" ? media.size : undefined;
      const expiry = typeof media.expires_at === "string" ? media.expires_at : undefined;
      links.set(uri, {
        type: "resource_link",
        uri,
        name,
        mimeType: media.mime_type,
        description: `Вложение поста ${object.message_id}${size === undefined ? "" : `; ${size} байт`}${expiry ? `; ссылка действует до ${expiry}` : ""}`,
      });
    }

    for (const key of ["results", "posts", "album", "reply_to", "before", "after"]) {
      if (object[key] !== undefined) visit(object[key]);
    }
  };

  visit(result);
  return [...links.values()];
}
