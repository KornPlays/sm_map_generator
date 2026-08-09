const CELL_SIZE = 64;

const GENERIC_QUEST_DETAILS = [
  ["Home is Where the Woc Is", ["Door Handle", "Modular Sofa", "Modular Sofa Armrest"]],
  ["Cardboard Munchies", ["Bonsai Tree", "Plant 1"]],
  ["Just a bot in a Cage", ["Blue Totebot Statue", "Yellow Totebot Statue", "Red Totebot Statue", "Green Totebot Statue"]],
  ["Heart of Corn", ["Ivy Pipe 2", "Ivy Pipe 1", "Ivy Pipe T", "Plant 2"]],
  ["Home is Where You go to Bed", ["Lowrider Plaque", "Wire Wheel", "Windshield", "Car Front Panel", "Car Back Panel", "Car Bumper", "Rearview Mirror", "Side Mirror"]],
  ["Make Some Noise", ["Synth", "Computer"]],
  ["Bee Like Me", ["Male Mechanic Statue", "Female Mechanic Statue", "Maintenance Ship Statue"]],
  ["If You Can't Take the Heat…", ["Gold Platinum Bearing", "A Part of the Scrapper Outfit"]],
  ["Round She Goes", ["Beach Ball", "A Part of the Scrapper Outfit"]],
  ["Onwards and Upwards", ["Anvil", "A Part of the Scrapper Outfit"]],
  ["Cageball Rock", ["Safe", "Duckie Backpack"]],
  ["Any Which Way but Home", ["Duckie Shoes", "Coffee Pot"]],
  ["Now the Flowers Will Grow", ["Duckie Pants", "Fountain Statue"]],
  ["Timber!", ["Plant 3", "A Part of the Scrapper Outfit"]],
  ["The Pop Don't Stop", ["Picture Frame"]],
  ["Itty Bitty Ditty", ["Lava Lamp", "A Part of the Scrapper Outfit"]],
  ["A Place to Dump Your Scrap", ["Duckie Hat", "Table Lamp", "Bowl"]],
  ["Every Bot Looks Like a Nail", ["Duckie Gloves", "Bowling Ball", "10 Pin"]],
  ["Building Bridges", ["Farmbot Statue", "A Part of the Scrapper Outfit"]],
  ["The Important Meal", ["Duckie Jacket", "Gas Stove", "Kitchen Pot"]],
];

const GENERIC_QUEST_LOCATIONS = [
  ["bb5acabd-562f-449f-bece-5a8351c34b6e", 23, 30.5],
  ["cd2e757d-249d-49af-979c-14428b41f7ad", 24.75, 22.5],
  ["6c57b05d-36c7-46df-ae45-7403f756199d", 30.25, 31.5],
  ["d5532a26-4450-4bc7-9db9-ff370be3dee9", 36.75, 38.25],
  ["6ddf24cb-db84-4534-81a8-a9ce81e83d84", 30, 33.25],
  ["c62ca228-3190-4c09-bd1a-88eb32e0695b", 24.25, 33.5],
  ["4bb32278-6e87-482d-a9e3-3476a45a194b", 29, 23],
  ["84cce463-a967-443f-95ff-9fcdb73262b0", 35.75, 28],
  ["86854faa-1d4f-4f2a-bb57-877abb8dfbc3", 39.5, 39.25],
  ["e010fb27-2d28-44fb-a8e6-e9f9664850a7", 61.75, 58.75],
  ["5c34eac0-2870-4978-8f05-7478d6e03baa", 23.25, 29.25],
  ["9269286f-6bde-4d6d-ad57-3ef57c88980e", 32.25, 42.25],
  ["405bb852-e090-4ee5-8a2f-24f2395d5d5f", 29, 33.25],
  ["49b86128-327e-457c-98f5-1949bee17c3d", 28.75, 27],
  ["d149b9cf-de7e-4fcd-8e82-69c07214d3af", 28.75, 29.75],
  ["eb056a47-8122-4fd5-8f45-fbd96c249997", 70, 92.5],
  ["da1275c8-2133-442a-b649-6961a5ddeb7f", 81, 52.25],
  ["311d997e-b8b0-491d-ac9d-176335e94e97", 37, 70.75],
  ["328be143-d67d-4b73-a15a-3df26c106f20", 42.75, 66.75],
  ["d92fa65f-9eda-4e95-ac60-7cd35af64abf", 59.5, 66],
];

export const BUILDER_QUESTS = GENERIC_QUEST_LOCATIONS.map(([uid, x, y], index) => ({
  name: `builder_quest_${String(index + 2).padStart(2, "0")}`,
  title: GENERIC_QUEST_DETAILS[index][0],
  rewards: GENERIC_QUEST_DETAILS[index][1],
  uid,
  x,
  y,
})).concat([
  { name: "builder_quest_first_car", title: "Your First Car", rewards: ["Wow T-Shirt"], uid: "28c8f354-3919-46e4-a311-6c3ceee5b5d9", x: 94.145835876465, y: 51.541519165039 },
  { name: "builder_quest_harvest_car", title: "Your Work Car", rewards: ["Rock T-Shirt"], uid: "e732c8c9-4580-4ca9-98fd-dbb79c97a623", x: 26.958480834961, y: 52.145835876465 },
  { name: "builder_quest_advanced_car", title: "Your Nice Car", rewards: ["Fantastic T-Shirt"], uid: "f3dda4db-8450-4e9d-a501-ec6dbf14a78a", x: 112.14583587646, y: 15.041519165039 },
]);

// Original, code-rendered marker badges. These do not redistribute the game's
// compass artwork and remain legible when several kinds share one map area.
const MARKER_STYLES = {
  builderQuest: { iconKind: "hammer", theme: "builder" },
  warehouse: { iconKind: "warehouse", theme: "warehouse" },
  partUnlockStation: { iconKind: "unlock", theme: "unlock" },
  ruin: { iconKind: "ruin", theme: "ruin" },
  mechanicStation: { iconKind: "mechanic", theme: "mechanic" },
  growlab: { iconKind: "growlab", theme: "growlab" },
  packingStation: { iconKind: "packing", theme: "packing" },
  cagedFarmer: { iconKind: "farmer", theme: "farmer" },
  pondOil: { iconKind: "pond", theme: "pond-oil" },
  pondChemical: { iconKind: "pond", theme: "pond-chemical" },
};

const WAREHOUSES = new Map([
  ["e8dfc039-7879-40cb-8b69-696f88d1cb2c", { floors: 2 }],
  ["887b1866-009d-430d-923c-53f7f6e21f4c", { floors: 2 }],
  ["71acfa84-5a93-4d71-8263-abff15908985", { floors: 2 }],
  ["457232e5-8233-4dc8-8565-3433405ecd77", { floors: 2 }],
  ["5861d377-b27d-4ba7-9167-2ca064915e81", { floors: 2 }],
  ["dc5c1caf-885c-4b9e-a3d7-d2578b04e633", { floors: 2 }],
  ["afc8dacf-a2ec-4bc5-9ffb-166372b5fcd2", { floors: 2 }],
  ["4283ed68-9811-4fc6-91b6-156fda5c444f", { floors: 2 }],
  ["cbeb1357-2027-4a90-bd03-632ccd4509b5", { floors: 3 }],
  ["3f35b614-e5da-41b1-ad2c-2959a9ae77d6", { floors: 3 }],
  ["b626a6fa-5930-4196-99dd-bf36f629bd0d", { floors: 4 }],
  ["669a9132-e9c2-4961-a6ad-869044058024", { floors: 4 }],
  ["5e9fa630-76fe-4693-be63-00ecd9acf201", { floors: 4, trashbot: true }],
]);

// Positions come from the caged-farmer shape transforms in the game's .tileson files.
const CAGED_FARMER_LOCATIONS = [
  ["16a6315e-897a-4186-abe9-cdf83470757a", [[32.717, 30.457]]],
  ["05b6d448-59fa-4abd-8986-5e331eb49af1", [[40.739, 22.970]]],
  ["9b11721e-3df5-438e-92a3-9ce08c5a8e84", [[37.918, 28.804]]],
  ["0556fb22-cacc-4402-8d7c-6cfd6f5d39ce", [[34.810, 34.483]]],
  ["afa0fd48-9c11-43c0-8519-def13c56eb7f", [[28.172, 27.374]]],
  ["bfd3e6e5-bd62-4bb9-8ab5-a12d2d44ffa3", [[25.499, 35.994]]],
  ["2cc399c0-7f60-4737-8ce9-dfebe1cff997", [[41.027, 42.522]]],
  ["2baccd93-fb01-49ba-bbce-f26bd6bba53c", [[20.869, 29.250]]],
  ["f7862697-5c60-412d-8508-2e37e8ec7d16", [[33.887, 30.722]]],
  ["150b28d3-2c48-40b8-a657-907629c63637", [[25.389, 36.347]]],
  ["139ff089-19e7-4c65-b02e-0bcdb30e4600", [[34.263, 31.131]]],
  ["e4fbd2dd-6d4a-4bfa-a311-6ae40fdd0f64", [[35.183, 33.862], [25.186, 33.862]]],
  ["75adfa70-b50e-428e-a035-580091009aee", [[28.250, 38.000], [40.250, 33.981]]],
  ["adc981bf-6a97-4c97-a303-b0066ccea342", [[23.250, 28.000]]],
  ["ddc41612-20f3-484e-b7eb-c0d510d190be", [[26.250, 27.500], [36.017, 34.113]]],
  ["33f54ce4-2287-4d9c-a5b1-a62eeca38127", [[99.215, 112.183], [73.528, 94.104], [128.569, 96.020]]],
  ["e7703a66-88a4-44c3-b99d-b22b8418c28b", [[49.411, 45.847]]],
  ["b0355ca4-2aec-4a08-8a4a-ac5ea8542055", [[52.863, 97.094]]],
  ["4df0a671-7c8c-4db7-9a6d-3be6e987731e", [[77.342, 84.094], [68.684, 83.363]]],
  ["c60fb408-5ca6-45eb-98d0-dc9a05ed7a66", [[56.234, 95.498], [64.123, 83.598]]],
  ["c1af7c32-42e8-471f-93b6-019f2c22ed10", [[358.500, 125.750], [243.537, 381.779]]],
  ["dd8b2c81-c9c5-4314-a069-65fa9cea3024", [[19.180, 35.757]]],
  ["c3bda64c-61c7-4dec-9ae0-c6bb2b7a395d", [[17.689, 17.552]]],
  ["2fc07dd0-482c-4eb5-86a0-2d48ba50fad3", [[33.407, 42.449]]],
  ["6cca7d2f-a07b-4133-9ac3-265715be70f6", [[53.135, 36.910]]],
  ["a3b7e066-2530-404e-9c4b-d311f569748c", [[73.669, 55.239]]],
  ["ca8cce51-4e86-4c38-b2a0-e21facb13229", [[33.012, 39.298]]],
  ["0de47979-bf12-4665-bf58-692b5e129b1c", [[19.456, 49.836]]],
  ["5b2285e1-5d70-4598-8831-619911c22d5a", [[29.062, 16.095]]],
  ["08f0037b-9233-4fe8-b7e1-c1a0c4a2913b", [[343.640, 191.713]]],
  ["b5b956c1-bab0-4bbe-abb0-e0ab8d3f1fab", [[155.455, 202.887]]],
];
const PART_UNLOCK_UIDS = new Set([
  "2908dd45-9767-4c9a-aa00-871a3a0b04b5", "d26c9186-24ea-42fa-a6d3-fc6536bb2725",
  "f32ebca6-dd04-462f-a614-884dcb55ccfe", "560ee0c0-5a35-429d-9533-9b9351d82df5",
]);
const MECHANIC_UIDS = new Set([
  "3ef31461-6f4e-4fb5-938d-875fb837d736", "2c36976b-e008-408c-a5b5-1baaaf01df04",
]);
const RUIN_UIDS = new Set([
  "190ac485-1f21-4490-abdb-0fb1592ab356", "dd8b2c81-c9c5-4314-a069-65fa9cea3024",
  "afe1dcc6-0894-4e95-a439-84463fc2a2e4", "51ee58d4-5d91-4914-aa42-d35c4521a23b",
  "c3bda64c-61c7-4dec-9ae0-c6bb2b7a395d", "c0261f9b-a288-475a-957a-33e01e964002",
  "61fbf237-7ca1-4310-a70b-85c5c047aa1c", "2fc07dd0-482c-4eb5-86a0-2d48ba50fad3",
  "a372e03c-8006-44ab-a8ee-15bffec72dbe", "921eeedd-3f10-47a5-aabb-81b65db23b06",
  "0a028fbe-5580-4abc-b48a-66c6a0f67c8e", "6cca7d2f-a07b-4133-9ac3-265715be70f6",
  "19f3fd49-1aa9-4aea-9fe5-6be46f73844f", "9958e995-8416-4970-945f-181c0c8add04",
  "36004765-1886-4e65-9c61-26526ae925e3", "3d581892-c351-4a03-a117-562f2a25f18d",
  "a3b7e066-2530-404e-9c4b-d311f569748c", "70e2d931-7c97-4290-bdbf-436db8582f71",
  "31d05f8f-c1a5-493b-8ff0-91dc9af302e4", "10bac32b-48ac-401a-9d7c-b215fc84aa98",
  "68794ad2-e70f-4f68-8dc1-4b396a927d07", "ca8cce51-4e86-4c38-b2a0-e21facb13229",
  "1f041ba4-4fc1-49ec-bf98-63ad8e1f1b96", "240b28e9-e298-4306-8d77-aca4b2581670",
  "18216217-7c49-40ee-afb3-38d2e9555fb8", "0de47979-bf12-4665-bf58-692b5e129b1c",
  "a132fdc0-2417-4181-91b6-26176657ea4e", "95da1468-8960-4fa7-9157-b5bc478466a4",
  "5b2285e1-5d70-4598-8831-619911c22d5a", "8e3f35e9-c142-4508-87fd-d48affb22fea",
  "7ba6fefb-8a07-49b8-b61f-a4d4305ecb47", "a47695ef-2028-44c7-8247-5fcad4e10bf8",
]);

const CHEMICAL_POND_UIDS = new Set([
  "e7703a66-88a4-44c3-b99d-b22b8418c28b", "b0355ca4-2aec-4a08-8a4a-ac5ea8542055",
  "4df0a671-7c8c-4db7-9a6d-3be6e987731e", "61e5f92c-54eb-478f-943b-38a32348c713",
  "9755ee40-7f23-4380-8a63-8055060fd18b", "013e980d-2425-4275-9c4b-c0eee0dba7f1",
]);
const OIL_POND_UIDS = new Set([
  "c60fb408-5ca6-45eb-98d0-dc9a05ed7a66", "84b61087-2a16-41ee-b23f-56aa4ff5d056",
  "465b42d9-4db1-4b10-925b-8d517ad37edb",
]);

const SPECIAL_STRUCTURES = [
  { kind: "packingStation", title: "Vegetable Packing Station", uid: "f3dda4db-8450-4e9d-a501-ec6dbf14a78a", x: 37, y: 102 },
  { kind: "packingStation", title: "Fruit Packing Station", uid: "9f3b2d02-a1b2-4717-99b8-83cae87bcb7c", x: 37, y: 102 },
  { kind: "growlab", title: "Growlab 1", listTitle: "Unlocks", rewards: ["Carrot Seeds", "Large Chest"], uid: "e70e6ba1-29a3-40a4-9ec3-cc2ed60a69c9", x: 135.5, y: 152 },
  { kind: "growlab", title: "Growlab 2", listTitle: "Unlocks", rewards: ["Redbeet Seeds", "Beehive"], uid: "d159bbf6-7b87-4073-8da7-c6cc3b85e4b5", x: 118.5, y: 114 },
  { kind: "growlab", title: "Growlab 3", listTitle: "Unlocks", rewards: ["Banana Seeds", "Freezer"], uid: "312e8d1c-de9c-479d-861a-cace1cb480f7", x: 131, y: 112 },
  { kind: "growlab", title: "Growlab 4", listTitle: "Unlocks", rewards: ["Blueberry Seeds", "Spud Shotgun"], uid: "b5b956c1-bab0-4bbe-abb0-e0ab8d3f1fab", x: 102.5, y: 96 },
  { kind: "growlab", title: "Growlab 5", listTitle: "Unlocks", rewards: ["Orange Seeds", "Thruster"], uid: "08f0037b-9233-4fe8-b7e1-c1a0c4a2913b", x: 295.5, y: 256 },
  { kind: "growlab", title: "Growlab 6", listTitle: "Unlocks", rewards: ["Broccoli Seeds", "XXL Chest"], uid: "8e1538ae-6169-4053-b9ae-d80258c6fb3b", x: 210, y: 334 },
  { kind: "growlab", title: "Growlab 7", listTitle: "Unlocks", rewards: ["Pineapple Seeds", "Fireworks"], uid: "c1af7c32-42e8-471f-93b6-019f2c22ed10", x: 229, y: 194.75 },
];

function rotateLocal(rotation, x, y, size) {
  const extent = size * CELL_SIZE;
  if (rotation === 1) return [extent - y, x];
  if (rotation === 2) return [extent - x, extent - y];
  if (rotation === 3) return [y, extent - x];
  return [x, y];
}

function groupCells(cells) {
  const groups = new Map();
  for (const cell of cells) {
    const key = cell.size > 1 ? `${cell.uid}:${cell.group}` : `${cell.uid}:${cell.x}:${cell.y}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(cell);
  }
  return [...groups.values()].map((members) => ({
    uid: members[0].uid,
    size: members[0].size,
    rotation: members[0].rotation,
    minimumX: Math.min(...members.map((cell) => cell.x)),
    minimumY: Math.min(...members.map((cell) => cell.y)),
  }));
}

function markerAt(group, localX, localY, details) {
  const [x, y] = rotateLocal(group.rotation, localX, localY, group.size);
  const style = MARKER_STYLES[details.theme || details.kind] || { iconKind: "dot", theme: "default" };
  return {
    ...details,
    ...style,
    x: group.minimumX * CELL_SIZE + x,
    y: group.minimumY * CELL_SIZE + y,
  };
}

export function findMapMarkers(cells) {
  const groups = groupCells(cells);
  const groupsByUid = new Map();
  for (const group of groups) {
    if (!groupsByUid.has(group.uid)) groupsByUid.set(group.uid, []);
    groupsByUid.get(group.uid).push(group);
  }

  const markers = [];
  for (const quest of BUILDER_QUESTS) {
    const group = groupsByUid.get(quest.uid)?.[0];
    if (group) markers.push(markerAt(group, quest.x, quest.y, { ...quest, kind: "builderQuest" }));
  }
  for (const group of groups) {
    const center = group.size * CELL_SIZE / 2;
    const warehouse = WAREHOUSES.get(group.uid);
    if (warehouse) {
      const suffix = warehouse.trashbot ? " (Trashbot)" : "";
      markers.push(markerAt(group, center, center, {
        kind: "warehouse",
        title: `Warehouse · ${warehouse.floors} Floors${suffix}`,
      }));
    } else if (PART_UNLOCK_UIDS.has(group.uid)) {
      markers.push(markerAt(group, center, center, { kind: "partUnlockStation", title: "Part Unlock Station" }));
    } else if (MECHANIC_UIDS.has(group.uid)) {
      markers.push(markerAt(group, center, center, { kind: "mechanicStation", title: "Mechanic Station" }));
    } else if (RUIN_UIDS.has(group.uid)) {
      markers.push(markerAt(group, center, center, { kind: "ruin", title: "Ruin" }));
    } else if (CHEMICAL_POND_UIDS.has(group.uid)) {
      markers.push(markerAt(group, center, center, { kind: "pond", theme: "pondChemical", title: "Chemical Pond" }));
    } else if (OIL_POND_UIDS.has(group.uid)) {
      markers.push(markerAt(group, center, center, { kind: "pond", theme: "pondOil", title: "Oil Pond" }));
    }
  }
  for (const structure of SPECIAL_STRUCTURES) {
    const group = groupsByUid.get(structure.uid)?.[0];
    if (group) markers.push(markerAt(group, structure.x, structure.y, structure));
  }
  for (const [uid, locations] of CAGED_FARMER_LOCATIONS) {
    for (const group of groupsByUid.get(uid) || []) {
      for (const [x, y] of locations) {
        markers.push(markerAt(group, x, y, { kind: "cagedFarmer", title: "Caged Farmer" }));
      }
    }
  }
  return markers;
}

export function findBuilderQuestMarkers(cells) {
  return findMapMarkers(cells).filter((marker) => marker.kind === "builderQuest");
}
