import { MARKER_ICONS } from "./markers.js";

export function applyMarkerGlyph(element, iconKind) {
  const glyph = MARKER_ICONS[iconKind];
  element.dataset.rasterIcon = glyph ? "true" : "false";
  if (glyph) element.style.setProperty("--marker-glyph", `url("${glyph}")`);
  else element.style.removeProperty("--marker-glyph");
}
