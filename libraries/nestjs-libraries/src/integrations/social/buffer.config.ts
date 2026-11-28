import type { BufferService } from './buffer.client';

export const bufferProviders = {
  'x-buffer': { service: 'twitter', name: 'X (via Buffer)', env: 'BUFFER_X_CHANNEL_ID', maxLength: 280 },
  'linkedin-buffer': { service: 'linkedin', name: 'LinkedIn Page (via Buffer)', env: 'BUFFER_LINKEDIN_CHANNEL_ID', maxLength: 3000 },
  'tiktok-buffer': { service: 'tiktok', name: 'TikTok (via Buffer)', env: 'BUFFER_TIKTOK_CHANNEL_ID', maxLength: 2200 },
} as const satisfies Record<string, { service: BufferService; name: string; env: string; maxLength: number }>;
export type BufferProviderId = keyof typeof bufferProviders;
export function isBufferProvider(id: string): id is BufferProviderId {
  return Object.prototype.hasOwnProperty.call(bufferProviders, id);
}
export function getBufferConfig(id: string) {
  if (!isBufferProvider(id)) return undefined;
  const definition = bufferProviders[id];
  const key = process.env.BUFFER_API_KEY?.trim();
  const organizationId = process.env.BUFFER_ORGANIZATION_ID?.trim();
  const postizOrgId = process.env.BUFFER_POSTIZ_ORGANIZATION_ID?.trim();
  const channelId = process.env[definition.env]?.trim();
  const mediaOrigin = (process.env.BUFFER_MEDIA_ORIGIN || process.env.CLOUDFLARE_BUCKET_URL)?.trim();
  if (!key || !organizationId || !postizOrgId || !channelId || !mediaOrigin) return undefined;
  return { ...definition, key, organizationId, postizOrgId, channelId, mediaOrigin };
}
export function bufferOrganizationAllowed(id: string, postizOrgId: string) {
  return !isBufferProvider(id) || getBufferConfig(id)?.postizOrgId === postizOrgId;
}
