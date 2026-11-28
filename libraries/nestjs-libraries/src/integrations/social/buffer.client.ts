/**
 * Server-only client for Buffer's GraphQL API.
 * Keep credentials and arbitrary remote response bodies out of errors.
 */
export type BufferService = 'twitter' | 'linkedin' | 'tiktok';
export type BufferChannel = {
  id: string; organizationId: string; name: string;
  displayName?: string | null; service: string; type: string;
  isDisconnected: boolean; isLocked: boolean; isQueuePaused: boolean;
};
export type BufferPost = {
  id: string; channelId: string; status: string; externalLink?: string | null;
};
export type BufferSettings = { title?: string; isAiGenerated?: boolean };
type Media = { path: string; alt?: string };
type Asset = { image: { url: string; metadata?: { altText: string } } } |
  { video: { url: string } };

export async function bufferRequest<T>(
  key: string, query: string, variables: Record<string, unknown> = {},
  fetcher: typeof fetch = fetch
): Promise<T> {
  if (!key.trim()) throw new Error('Buffer API key is missing.');
  let response: Response;
  try {
    response = await fetcher('https://api.buffer.com', {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(25000),
      headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables }),
    });
  } catch {
    throw new Error('Buffer request timed out or could not connect.');
  }
  if (!response.ok) throw new Error('Buffer API returned HTTP ' + response.status + '.');
  let body: { data?: T; errors?: unknown[] };
  try { body = await response.json(); }
  catch { throw new Error('Buffer returned an unreadable response.'); }
  if (body.errors?.length || !body.data) throw new Error('Buffer rejected the GraphQL request.');
  return body.data;
}

export async function getBufferChannel(key: string, channelId: string) {
  const data = await bufferRequest<{ channel: BufferChannel }>(
    key, 'query Channel($input: ChannelInput!) { channel(input: $input) { id organizationId name displayName service type isDisconnected isLocked isQueuePaused } }',
    { input: { id: channelId } }
  );
  if (!data.channel?.id) throw new Error('Buffer channel not found.');
  return data.channel;
}

export function buildBufferAssets(service: BufferService, media: Media[], mediaOrigin: string): Asset[] {
  let origin: URL;
  try { origin = new URL(mediaOrigin); }
  catch { throw new Error('Configure a public HTTPS media origin for Buffer.'); }
  if (origin.protocol !== 'https:' || origin.username || origin.password || origin.search || origin.hash)
    throw new Error('Buffer requires a public HTTPS media origin.');
  const assets = media.map((item): Asset => {
    let url: URL;
    try { url = new URL(item.path); }
    catch { throw new Error('Buffer requires publicly accessible media URLs.'); }
    if (url.protocol !== 'https:' || url.origin !== origin.origin ||
        url.username || url.password || url.search || url.hash ||
        (origin.pathname !== '/' && !url.pathname.startsWith(origin.pathname.replace(/\/+$/, '') + '/')))
      throw new Error('Buffer media must use the configured public media origin.');
    const extension = url.pathname.split('.').pop()?.toLowerCase();
    if (extension === 'mp4') return { video: { url: url.href } };
    if (['jpg', 'jpeg', 'png'].includes(extension || ''))
      return { image: { url: url.href, ...(item.alt ? { metadata: { altText: item.alt } } : {}) } };
    throw new Error('Buffer channels currently support JPEG, PNG and MP4 media.');
  });
  const videos = assets.filter((asset) => 'video' in asset).length;
  if (videos && (videos !== 1 || assets.length !== 1))
    throw new Error('Use one video or a set of photos; do not mix media types.');
  const maxPhotos = { twitter: 4, linkedin: 9, tiktok: 10 }[service];
  if (!videos && assets.length > maxPhotos) throw new Error('Use no more than ' + maxPhotos + ' photos.');
  if (service === 'tiktok' && !assets.length) throw new Error('TikTok requires an image or video.');
  return assets;
}

export function buildBufferPostInput(
  channelId: string, service: BufferService, text: string, media: Media[],
  mediaOrigin: string, settings: BufferSettings = {}
) {
  const assets = buildBufferAssets(service, media, mediaOrigin);
  if (!text.trim() && !assets.length) throw new Error('The post is empty.');
  const isVideo = assets.some((asset) => 'video' in asset);
  let metadata: Record<string, unknown> | undefined;
  if (service === 'twitter' && settings.isAiGenerated === true)
    metadata = { twitter: { isAiGenerated: true } };
  if (service === 'tiktok') {
    const title = settings.title?.trim() || '';
    if (title.length > 90) throw new Error('TikTok photo title must not exceed 90 characters.');
    if (!isVideo && !title) throw new Error('Enter a TikTok photo title in channel settings.');
    metadata = { tiktok: isVideo ? { isAiGenerated: settings.isAiGenerated === true } : { title } };
  }
  return { channelId, text, assets, mode: 'shareNow', schedulingType: 'automatic',
    needsApproval: false, saveToDraft: false, ...(metadata ? { metadata } : {}) };
}

export async function createBufferPost(key: string, input: ReturnType<typeof buildBufferPostInput>) {
  const data = await bufferRequest<{ createPost: { __typename: string; post?: BufferPost; message?: string } }>(
    key, 'mutation Create($input: CreatePostInput!) { createPost(input: $input) { __typename ... on PostActionSuccess { post { id channelId status externalLink } } ... on MutationError { message } } }',
    { input }
  );
  return data.createPost;
}

export async function getBufferPost(key: string, postId: string) {
  const data = await bufferRequest<{ post: BufferPost }>(
    key, 'query Post($input: PostInput!) { post(input: $input) { id channelId status externalLink } }',
    { input: { id: postId } }
  );
  if (!data.post?.id) throw new Error('Buffer post not found.');
  return data.post;
}
