import { randomBytes } from 'crypto';
import { Integration } from '@prisma/client';
import { timer } from '@gitroom/helpers/utils/timer';
import { weightedLength } from '@gitroom/helpers/utils/count.length';
import { ioRedis } from '@gitroom/nestjs-libraries/redis/redis.service';
import { BufferDto } from '@gitroom/nestjs-libraries/dtos/posts/providers-settings/buffer.dto';
import { BadBody, SocialAbstract, ValidityMedia } from '@gitroom/nestjs-libraries/integrations/social.abstract';
import { AuthTokenDetails, PendingCheckResponse, PostDetails, PostResponse, SocialProvider } from './social.integrations.interface';
import { BufferChannel, buildBufferAssets, buildBufferPostInput, createBufferPost, getBufferChannel, getBufferPost } from './buffer.client';
import { bufferProviders, BufferProviderId, getBufferConfig } from './buffer.config';

type Config = NonNullable<ReturnType<typeof getBufferConfig>>;
type Pending = { bufferPostId: string; channelId: string };
const receiptTtl = 730 * 24 * 60 * 60;
const knownRejections = new Set(['NotFoundError', 'UnauthorizedError', 'LimitReachedError', 'InvalidInputError']);

export class BufferProvider extends SocialAbstract implements SocialProvider {
  readonly identifier: BufferProviderId;
  readonly name: string;
  readonly editor = 'normal' as const;
  readonly isBetweenSteps = false;
  readonly scopes: string[] = [];
  readonly dto = BufferDto;
  constructor(identifier: BufferProviderId) {
    super();
    this.identifier = identifier;
    this.name = bufferProviders[identifier].name;
  }
  maxLength() { return bufferProviders[this.identifier].maxLength; }
  private failure(message: string) {
    return new BadBody(this.identifier, '{}', '{}', message);
  }
  private config(integration?: Integration): Config {
    const config = getBufferConfig(this.identifier);
    if (!config) throw this.failure('Buffer channel configuration is incomplete.');
    if (integration && (integration.organizationId !== config.postizOrgId ||
        integration.internalId !== this.identifier + ':' + config.channelId))
      throw this.failure('Buffer channel no longer matches the configured workspace. Reconnect it.');
    return config;
  }
  async generateAuthUrl() {
    this.config();
    const state = randomBytes(32).toString('hex');
    const code = randomBytes(32).toString('hex');
    const url = new URL('/integrations/social/' + this.identifier, process.env.FRONTEND_URL);
    url.searchParams.set('state', state);
    url.searchParams.set('code', code);
    return { url: url.toString(), state, codeVerifier: code };
  }
  private validateChannel(channel: BufferChannel, config: Config) {
    if (channel.id !== config.channelId || channel.organizationId !== config.organizationId ||
        channel.service !== config.service || (config.service === 'linkedin' && channel.type !== 'page'))
      throw this.failure('Configured Buffer channel does not match the selected company account.');
    if (channel.isLocked || channel.isDisconnected || channel.isQueuePaused)
      throw this.failure('The Buffer channel is locked, disconnected, or paused. Check Buffer.');
  }
  private async credentials(): Promise<AuthTokenDetails> {
    const config = this.config();
    const channel = await getBufferChannel(config.key, config.channelId);
    this.validateChannel(channel, config);
    return { id: this.identifier + ':' + channel.id,
      name: (channel.displayName || channel.name) + ' - via Buffer', username: channel.name,
      // Never store the real Buffer API key as a Postiz integration token.
      accessToken: 'buffer-env', refreshToken: '' };
  }
  async authenticate(params: { code: string; codeVerifier: string }) {
    if (!params.code || params.code !== params.codeVerifier)
      return 'The Buffer connection link has expired. Add the channel again.';
    try { return await this.credentials(); }
    catch { return 'Could not connect the configured Buffer channel. Check its key, workspace, ID and connection in Buffer.'; }
  }
  async refreshToken(_refreshToken: string): Promise<AuthTokenDetails> { return this.credentials(); }

  override async checkValidity(posts: ValidityMedia[][], settings: BufferDto): Promise<string | true> {
    try {
      if (posts.length !== 1) return 'Buffer channels support single posts only; remove replies or comments.';
      const config = this.config();
      const assets = buildBufferAssets(config.service, posts[0] || [], config.mediaOrigin);
      if (config.service === 'tiktok' && !assets.some((asset) => 'video' in asset) && !settings?.title?.trim())
        return 'Enter a TikTok photo title in channel settings.';
      return true;
    } catch (error) { return error instanceof Error ? error.message : 'Invalid Buffer media.'; }
  }

  async postPending(id: string, _accessToken: string, posts: PostDetails<BufferDto>[], integration: Integration): Promise<PostResponse[]> {
    const config = this.config(integration);
    if (id !== integration.internalId || posts.length !== 1 || !posts[0]?.id)
      throw this.failure('Buffer requires a single valid post without replies or comments.');
    if (!process.env.REDIS_URL)
      throw this.failure('Buffer publishing requires persistent Redis for duplicate protection.');
    const post = posts[0];
    let input: ReturnType<typeof buildBufferPostInput>;
    try {
      const length = config.service === 'twitter' ? weightedLength(post.message || '') : (post.message || '').length;
      if (length > this.maxLength()) throw new Error('Post exceeds the Buffer channel character limit.');
      input = buildBufferPostInput(config.channelId, config.service, post.message || '',
        post.media || [], config.mediaOrigin, post.settings || {});
    } catch (error) { throw this.failure(error instanceof Error ? error.message : 'Invalid Buffer post.'); }
    const receiptKey = 'buffer:publish:' + integration.organizationId + ':' + integration.id + ':' + post.id;
    const toPending = (data: Pending): PostResponse[] => [{
      id: post.id, postId: '', releaseURL: '', status: 'pending', pendingData: data,
    }];
    const existing = await ioRedis.get(receiptKey);
    if (existing) {
      if (existing !== 'attempted') {
        const data = JSON.parse(existing) as Pending;
        if (data.bufferPostId && data.channelId === config.channelId) return toPending(data);
      }
      throw this.failure('A previous Buffer publish attempt is unconfirmed. Check Buffer before creating a replacement post.');
    }
    // A read-only preflight happens before claiming the irreversible attempt.
    try { this.validateChannel(await getBufferChannel(config.key, config.channelId), config); }
    catch (error) {
      if (error instanceof BadBody) throw error;
      throw this.failure('Could not verify the Buffer channel. Check its configuration and connection.');
    }
    const claimed = await ioRedis.set(receiptKey, 'attempted', 'EX', receiptTtl, 'NX');
    if (!claimed) throw this.failure('A Buffer publish attempt already exists. Check its status before retrying.');
    let result: Awaited<ReturnType<typeof createBufferPost>>;
    try { result = await createBufferPost(config.key, input); }
    catch {
      // A network error can happen after the mutation ran: never replay it.
      throw this.failure('Buffer may have accepted this post, but the response was unconfirmed. Check Buffer before retrying.');
    }
    if (result?.__typename !== 'PostActionSuccess' || !result.post?.id || result.post.channelId !== config.channelId) {
      if (knownRejections.has(result?.__typename || '')) {
        await ioRedis.del(receiptKey);
        throw this.failure('Buffer refused the post (' + result.__typename + '). Review permissions, media and plan limits.');
      }
      throw this.failure('Buffer returned an unconfirmed publish result. Check Buffer before retrying.');
    }
    const pending = { bufferPostId: result.post.id, channelId: config.channelId };
    try { await ioRedis.set(receiptKey, JSON.stringify(pending), 'EX', receiptTtl, 'XX'); }
    catch { /* Current workflow still has the remote ID; marker blocks retries. */ }
    return toPending(pending);
  }

  override async checkPostStatus(_accessToken: string, pendingData: Pending, integration: Integration): Promise<PendingCheckResponse> {
    const config = this.config(integration);
    if (!pendingData?.bufferPostId || pendingData.channelId !== config.channelId)
      throw this.failure('The Buffer publish receipt is invalid.');
    const post = await getBufferPost(config.key, pendingData.bufferPostId);
    if (post.channelId !== config.channelId) throw this.failure('Buffer returned a post for another channel.');
    if (post.status === 'sent') {
      let releaseURL = '';
      try {
        const url = new URL(post.externalLink || '');
        if (url.protocol === 'https:' && !url.username && !url.password) releaseURL = url.href;
      } catch {}
      return { status: 'completed', postId: post.id, releaseURL };
    }
    if (['error', 'draft', 'needs_approval'].includes(post.status))
      throw this.failure('Buffer did not publish this post (' + post.status + '). Review it in Buffer. Post ID: ' + post.id);
    if (!['scheduled', 'sending'].includes(post.status))
      throw this.failure('Buffer returned an unknown status. Check Buffer before retrying.');
    return { status: 'pending', pendingData };
  }

  // Legacy workflows cannot resolve pending responses. Poll within the
  // activity deadline, never reporting a queued item as a successful post.
  async post(id: string, accessToken: string, posts: PostDetails<BufferDto>[], integration: Integration): Promise<PostResponse[]> {
    const [response] = await this.postPending(id, accessToken, posts, integration);
    const deadline = Date.now() + 8 * 60 * 1000;
    while (Date.now() < deadline) {
      const status = await this.checkPostStatus(accessToken, response.pendingData, integration);
      if (status.status === 'completed')
        return [{ id: response.id, status: 'success', postId: status.postId, releaseURL: status.releaseURL }];
      await timer(20000);
    }
    throw this.failure('Buffer publishing is still unconfirmed. Check Buffer before retrying.');
  }
}
