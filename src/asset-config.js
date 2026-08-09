// These are the two public tile sources that a self-hosted generator may
// configure independently. The exported viewer code itself is embedded from
// the current build, so an old download never depends on a future JS update.
export const GENERATOR_ASSET_SOURCE = "assets/";
export const EXPORTED_VIEWER_ASSET_SOURCE = "https://sm.kornplays.com/assets/";
// Bump this whenever captured tile files are replaced without changing their names.
export const TILE_ASSET_REVISION = "v7-200-20260809-f";

export function assetUrl(path, baseUrl = document.baseURI, source = GENERATOR_ASSET_SOURCE) {
  return new URL(path, new URL(source, baseUrl));
}

export function tileAssetUrl(path, baseUrl = document.baseURI, source = GENERATOR_ASSET_SOURCE) {
  const url = assetUrl(path, baseUrl, source);
  url.searchParams.set("v", TILE_ASSET_REVISION);
  return url;
}
