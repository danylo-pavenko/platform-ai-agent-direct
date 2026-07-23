import versionJson from '@platform-version';

export interface PlatformVersion {
  name: string;
  code: number;
}

export const platformVersion: PlatformVersion = {
  name: String((versionJson as { name?: string }).name ?? '0.0'),
  code: Number((versionJson as { code?: number }).code ?? 0),
};

export function formatPlatformVersion(v: PlatformVersion = platformVersion): string {
  return `v${v.name} (${v.code})`;
}
