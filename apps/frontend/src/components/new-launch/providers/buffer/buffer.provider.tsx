'use client';

import { PostComment, withProvider } from '@gitroom/frontend/components/new-launch/providers/high.order.provider';
import { useSettings } from '@gitroom/frontend/components/launches/helpers/use.values';
import { Checkbox } from '@gitroom/react/form/checkbox';
import { Input } from '@gitroom/react/form/input';
import { BufferDto } from '@gitroom/nestjs-libraries/dtos/posts/providers-settings/buffer.dto';

const XSettings = () => {
  const { register } = useSettings();
  return <Checkbox variant="hollow" label="Disclose AI-generated content"
    {...register('isAiGenerated', { value: false })} />;
};
const TikTokSettings = () => {
  const { register } = useSettings();
  return <div className="flex flex-col gap-[12px]">
    <Input label="TikTok photo title (required for photo posts)"
      placeholder="Enter a title" {...register('title')} />
    <Checkbox variant="hollow" label="Disclose AI-generated video"
      {...register('isAiGenerated', { value: false })} />
  </div>;
};
const common = {
  comments: false as const,
  postComment: PostComment.POST,
  minimumCharacters: [] as never[],
  dto: BufferDto,
};
export const BufferXProvider = withProvider<BufferDto>({
  ...common, SettingsComponent: XSettings, maximumCharacters: 280,
});
export const BufferLinkedInProvider = withProvider<BufferDto>({
  ...common, SettingsComponent: null, maximumCharacters: 3000,
});
export const BufferTikTokProvider = withProvider<BufferDto>({
  ...common, SettingsComponent: TikTokSettings, maximumCharacters: 2200,
});
