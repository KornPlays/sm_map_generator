import builderHammer from "./assets/markers/builder-hammer.png?inline";
import mechanicCog from "./assets/markers/mechanic-cog.png?inline";
import packingCrate from "./assets/markers/packing-crate.png?inline";
import partUnlock from "./assets/markers/part-unlock.png?inline";
import pond from "./assets/markers/pond.png?inline";
import ruin from "./assets/markers/ruin.png?inline";
import cagedFarmer from "./assets/markers/caged-farmer.png?inline";

const MARKER_GLYPHS = {
  hammer: builderHammer,
  mechanic: mechanicCog,
  packing: packingCrate,
  pond,
  ruin,
  farmer: cagedFarmer,
  unlock: partUnlock,
};

export function applyMarkerGlyph(element, iconKind) {
  const glyph = MARKER_GLYPHS[iconKind];
  element.dataset.rasterIcon = glyph ? "true" : "false";
  if (glyph) element.style.setProperty("--marker-glyph", `url("${glyph}")`);
  else element.style.removeProperty("--marker-glyph");
}
