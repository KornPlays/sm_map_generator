export const EXCAVATION_COMPOSITE_UIDS = new Set([
  // Raw world-file halves already represented by the calibrated 32x32 image.
  "ba31a522-7659-4ec5-b933-8b83960c57f2",
  "bf0ba240-416f-4f32-b87d-3a445919e72a",
  // This partially surviving 4x4 capture overlaps the correct smaller bridge
  // already present in the calibrated composite.
  "1ec32974-d07c-4ad1-a16c-57dcf90ca342",
]);

export const EXCAVATION_CHUNK_CELLS = 4;
export const EXCAVATION_CHUNKS_PER_SIDE = 32 / EXCAVATION_CHUNK_CELLS;

export function excavationChunkPath(column, row) {
  return `excavation/${column}_${row}.webp`;
}

export function excavationDetailPlacements() {
  const placements = [];
  for (let row = 0; row < EXCAVATION_CHUNKS_PER_SIDE; row += 1) {
    for (let column = 0; column < EXCAVATION_CHUNKS_PER_SIDE; column += 1) {
      placements.push({
        uid: `excavation-${column}-${row}`,
        assetPath: excavationChunkPath(column, row),
        size: EXCAVATION_CHUNK_CELLS,
        rotation: 0,
        x: 32 + column * EXCAVATION_CHUNK_CELLS,
        // Image rows run north-to-south while world Y increases northward.
        y: 47 - (row + 1) * EXCAVATION_CHUNK_CELLS + 1,
      });
    }
  }
  return placements;
}
