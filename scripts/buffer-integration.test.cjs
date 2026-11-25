// Dependency-light tests against the actual TypeScript provider and client.
// Run from the repo with Node 22+ and TypeScript installed: node --test scripts/buffer-integration.test.cjs
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const root = path.resolve(__dirname, '..', 'libraries/nestjs-libraries/src/integrations/social');
const origin = 'https://media.example.com';
const image = { path: origin + '/image.png', alt: 'Company announcement' };
const video = { path: origin + '/video.mp4' };

function fixture(providerId = 'x-buffer') {
  const env = {
    BUFFER_API_KEY: 'test-secret',
    BUFFER_ORGANIZATION_ID: 'buffer-org',
    BUFFER_POSTIZ_ORGANIZATION_ID: 'postiz-org',
    BUFFER_X_CHANNEL_ID: 'x-channel',
    BUFFER_LINKEDIN_CHANNEL_ID: 'linkedin-channel',
    BUFFER_TIKTOK_CHANNEL_ID: 'tiktok-channel',
    BUFFER_MEDIA_ORIGIN: origin,
    FRONTEND_URL: 'https://social.example.com',
    REDIS_URL: 'redis://test',
  };
  const service = { 'x-buffer': 'twitter', 'linkedin-buffer': 'linkedin', 'tiktok-buffer': 'tiktok' }[providerId];
  const channelId = { 'x-buffer': 'x-channel', 'linkedin-buffer': 'linkedin-channel', 'tiktok-buffer': 'tiktok-channel' }[providerId];
  const channel = {
    id: channelId, organizationId: 'buffer-org', name: 'Bulwark', displayName: 'Company',
    service, type: providerId === 'linkedin-buffer' ? 'page' : 'profile',
    isDisconnected: false, isLocked: false, isQueuePaused: false,
  };
  const calls = [];
  const receipts = new Map();
  let post = { id: 'remote-post', channelId, status: 'scheduled', externalLink: null };
  let createType = 'PostActionSuccess';
  let ambiguous = false;
  const fakeFetch = async (url, options) => {
    assert.equal(url, 'https://api.buffer.com');
    assert.equal(options.headers.Authorization, 'Bearer test-secret');
    assert.equal(options.redirect, 'error');
    const request = JSON.parse(options.body);
    calls.push(request);
    if (request.query.startsWith('query Channel')) return Response.json({ data: { channel } });
    if (request.query.startsWith('mutation Create')) {
      if (ambiguous) throw new Error('connection reset after request');
      return Response.json({ data: { createPost: createType === 'PostActionSuccess'
        ? { __typename: createType, post } : { __typename: createType, message: 'test rejection' } } });
    }
    if (request.query.startsWith('query Post')) return Response.json({ data: { post } });
    throw new Error('Unexpected query');
  };
  const redis = {
    async get(key) { return receipts.get(key) || null; },
    async set(key, value, _ex, _ttl, mode) {
      if (mode === 'NX' && receipts.has(key)) return null;
      if (mode === 'XX' && !receipts.has(key)) return null;
      receipts.set(key, value);
      return 'OK';
    },
    async del(key) { return Number(receipts.delete(key)); },
  };
  class BadBody extends Error {
    constructor(_id, _json, _body, message) { super(message); this.nonRetryable = true; }
  }
  const cache = new Map();
  function load(name) {
    if (cache.has(name)) return cache.get(name).exports;
    const file = path.join(root, name + '.ts');
    const source = fs.readFileSync(file, 'utf8');
    const compiled = ts.transpileModule(source, {
      fileName: file,
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
      reportDiagnostics: true,
    });
    assert.deepEqual(compiled.diagnostics.filter(d => d.category === ts.DiagnosticCategory.Error), []);
    const mod = { exports: {} };
    cache.set(name, mod);
    const requireMock = (specifier) => {
      if (specifier.startsWith('./')) return load(specifier.slice(2));
      if (specifier === 'crypto') return require('node:crypto');
      if (specifier.endsWith('/timer')) return { timer: async () => {} };
      if (specifier.endsWith('/count.length')) return { weightedLength: text => text.length };
      if (specifier.endsWith('/redis.service')) return { ioRedis: redis };
      if (specifier.endsWith('/buffer.dto')) return { BufferDto: class {} };
      if (specifier.endsWith('/social.abstract')) return { BadBody, SocialAbstract: class {} };
      throw new Error('Unexpected dependency: ' + specifier);
    };
    new Function('require', 'module', 'exports', 'process', 'fetch', compiled.outputText)(
      requireMock, mod, mod.exports, { env }, fakeFetch
    );
    return mod.exports;
  }
  const client = load('buffer.client');
  const config = load('buffer.config');
  const { BufferProvider } = load('buffer.provider');
  const provider = new BufferProvider(providerId);
  const integration = { id: 'integration', organizationId: 'postiz-org', internalId: providerId + ':' + channelId };
  const posts = [{ id: 'postiz-post', message: 'Hello', settings: providerId === 'tiktok-buffer' ? { title: 'News' } : {}, media: [image] }];
  return { env, channel, calls, receipts, client, config, provider, integration, posts,
    publish: () => provider.postPending(integration.internalId, 'buffer-env', posts, integration),
    setStatus: status => { post = { ...post, status, externalLink: status === 'sent' ? 'https://example.com/published' : null }; },
    setCreateType: type => { createType = type; },
    setAmbiguous: () => { ambiguous = true; },
    mutations: () => calls.filter(c => c.query.startsWith('mutation Create')),
  };
}

test('API uses correct media and shareNow input', () => {
  const { client } = fixture();
  const input = client.buildBufferPostInput('channel', 'twitter', 'Hello', [image], origin);
  assert.equal(input.mode, 'shareNow');
  assert.equal(input.schedulingType, 'automatic');
  assert.equal(input.needsApproval, false);
  assert.equal(input.saveToDraft, false);
  assert.deepEqual(input.assets, [{ image: { url: image.path, metadata: { altText: image.alt } } }]);
});

test('TikTok photo titles and video disclosure are enforced', () => {
  const { client } = fixture();
  assert.throws(() => client.buildBufferPostInput('c', 'tiktok', 'Text', [], origin), /requires/);
  assert.throws(() => client.buildBufferPostInput('c', 'tiktok', 'Text', [image], origin), /title/);
  assert.deepEqual(client.buildBufferPostInput('c', 'tiktok', 'Text', [image], origin, { title: 'News' }).metadata, { tiktok: { title: 'News' } });
  assert.deepEqual(client.buildBufferPostInput('c', 'tiktok', 'Text', [video], origin, { isAiGenerated: true }).metadata, { tiktok: { isAiGenerated: true } });
});

test('private URLs, unapproved origins, signed URLs, mixed media and excess photos are rejected', () => {
  const { client } = fixture();
  for (const p of ['/uploads/a.png', 'http://media.example.com/a.png', 'https://media.example.com.evil.test/a.png', origin + '/a.png?secret=x', origin + '/file.pdf'])
    assert.throws(() => client.buildBufferAssets('twitter', [{ path: p }], origin));
  assert.throws(() => client.buildBufferAssets('twitter', [image, video], origin), /mix/);
  assert.throws(() => client.buildBufferAssets('twitter', Array(5).fill(image), origin), /more than 4/);
});

test('credentials never expose the API key', async () => {
  const f = fixture();
  const auth = await f.provider.generateAuthUrl();
  assert.equal(new URL(auth.url).origin, 'https://social.example.com');
  assert.equal(new URL(auth.url).searchParams.get('code'), auth.codeVerifier);
  assert.ok(!auth.url.includes(f.env.BUFFER_API_KEY));
  assert.match(await f.provider.authenticate({ code: 'wrong', codeVerifier: auth.codeVerifier }), /expired/);
  const result = await f.provider.authenticate({ code: auth.codeVerifier, codeVerifier: auth.codeVerifier });
  assert.equal(result.id, f.integration.internalId);
  assert.equal(result.accessToken, 'buffer-env');
  assert.ok(!JSON.stringify(result).includes(f.env.BUFFER_API_KEY));
});

test('only configured workspace and LinkedIn Page may connect', async () => {
  const f = fixture('linkedin-buffer');
  assert.equal(f.config.bufferOrganizationAllowed('linkedin-buffer', 'postiz-org'), true);
  assert.equal(f.config.bufferOrganizationAllowed('linkedin-buffer', 'other'), false);
  f.channel.type = 'profile';
  const auth = await f.provider.generateAuthUrl();
  assert.equal(typeof await f.provider.authenticate({ code: auth.codeVerifier, codeVerifier: auth.codeVerifier }), 'string');
  await assert.rejects(f.publish(), /does not match/);
  assert.equal(f.mutations().length, 0);
});

test('all three providers accept queued then sent statuses; repeated attempts never create a second post', async () => {
  for (const id of ['x-buffer', 'linkedin-buffer', 'tiktok-buffer']) {
    const f = fixture(id);
    const [first] = await f.publish();
    assert.equal(first.status, 'pending');
    assert.equal(f.mutations()[0].variables.input.channelId, f.channel.id);
    const [retry] = await f.publish();
    assert.deepEqual(first, retry);
    assert.equal(f.mutations().length, 1);
    assert.equal((await f.provider.checkPostStatus('buffer-env', first.pendingData, f.integration)).status, 'pending');
    f.setStatus('sent');
    assert.deepEqual(await f.provider.checkPostStatus('buffer-env', first.pendingData, f.integration),
      { status: 'completed', postId: 'remote-post', releaseURL: 'https://example.com/published' });
  }
});

test('ambiguous response cannot be replayed', async () => {
  const f = fixture();
  f.setAmbiguous();
  await assert.rejects(f.publish(), /unconfirmed/);
  await assert.rejects(f.publish(), /previous Buffer publish attempt/);
  assert.equal(f.mutations().length, 1);
});

test('explicit validation rejection releases marker; unknown rejection does not', async () => {
  const f = fixture();
  f.setCreateType('InvalidInputError');
  await assert.rejects(f.publish(), /refused/);
  f.setCreateType('PostActionSuccess');
  await f.publish();
  assert.equal(f.mutations().length, 2);
  const g = fixture();
  g.setCreateType('UnexpectedError');
  await assert.rejects(g.publish(), /unconfirmed/);
  await assert.rejects(g.publish(), /unconfirmed/);
  assert.equal(g.mutations().length, 1);
});

test('wrong workspace, paused channel and no Redis block mutation', async () => {
  const f = fixture();
  f.integration.organizationId = 'other';
  await assert.rejects(f.publish(), /workspace/);
  f.integration.organizationId = 'postiz-org';
  f.channel.isQueuePaused = true;
  await assert.rejects(f.publish(), /paused/);
  f.channel.isQueuePaused = false;
  delete f.env.REDIS_URL;
  await assert.rejects(f.publish(), /Redis/);
  assert.equal(f.mutations().length, 0);
});

test('failed and approval-required posts are not marked as published', async () => {
  const f = fixture();
  const [p] = await f.publish();
  for (const status of ['error', 'draft', 'needs_approval']) {
    f.setStatus(status);
    await assert.rejects(f.provider.checkPostStatus('buffer-env', p.pendingData, f.integration), /did not publish/);
  }
});

test('HTTP and GraphQL errors do not expose response bodies', async () => {
  const { client } = fixture();
  await assert.rejects(client.bufferRequest('secret', 'query Q', {}, async () =>
    new Response('secret', { status: 401 })), err => /HTTP 401/.test(err.message) && !err.message.includes('secret'));
  await assert.rejects(client.bufferRequest('secret', 'query Q', {}, async () =>
    Response.json({ errors: [{ message: 'secret' }] })), err => /GraphQL/.test(err.message) && !err.message.includes('secret'));
});
