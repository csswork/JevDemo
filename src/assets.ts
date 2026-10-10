import { DefaultLoadingManager } from 'three';
import manifest from 'virtual:asset-manifest';

/** Content-hashed resources share one resolver across fetch and Three.js loaders. */
export function assetUrl(value: string): string {
  if (/^(data|blob):/.test(value)) return value;
  const url = new URL(value, location.href);
  if (url.origin !== location.origin) return value;
  const base = import.meta.env.BASE_URL;
  const key = `/${url.pathname.slice(base.length)}`;
  const target = manifest[key];
  return target ? `${base}${target.slice(1)}${url.search}${url.hash}` : value;
}

DefaultLoadingManager.setURLModifier(assetUrl);
