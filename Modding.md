# Modding the map generator

Marker modding is centered in one file: [`src/markers.js`](src/markers.js).
That file contains every marker type, its detection rule, settings label,
default visibility, color, icon, title, description, and reward data.

You do not need to edit `index.html`, the map viewer, or the exported viewer.
Adding an entry to `MARKER_TYPES` automatically adds its checkbox to the
settings menu everywhere.

## Add a marker type

Find `MARKER_TYPES` in `src/markers.js` and copy this object into the array:

```js
{
  kind: "myLocation",
  settingsLabel: "My Locations",
  detailsLabel: "My Location",
  defaultVisible: true,
  iconKind: "dot",
  theme: "my-location",
  color: "#62c8ff",

  detect({ groupsFor, center, add }) {
    const tileUid = "00000000-0000-0000-0000-000000000000";

    for (const group of groupsFor(tileUid)) {
      add(group, center(group), center(group), {
        title: "My Location",
        description: "A short explanation shown when the marker is clicked.",
        listTitle: "Contains",
        rewards: ["Item one", "Item two"],
      });
    }
  },
},
```

Change the UUID, labels, color, and text. The marker will be placed in the
center of every matching tile or multi-tile structure.

The important fields are:

- `kind`: a unique internal name. Keep it stable because visibility settings
  are stored under this name in the browser.
- `settingsLabel`: the name shown beside the settings checkbox.
- `detailsLabel`: the small category name shown after clicking a marker.
- `defaultVisible`: whether a new visitor sees this category immediately.
- `iconKind`: the icon name from `MARKER_ICONS`.
- `color`: any CSS color used for the border and icon.
- `detect`: the detection rule. Call `add` for every marker it finds.

`title`, `description`, `listTitle`, and `rewards` belong to an individual
marker. `description`, `listTitle`, and `rewards` are optional.

## Place a marker at an exact point

One 1×1 tile is 64×64 local units. The top-left of the unrotated tile is
`0, 0`; its center is `32, 32`. A 2×2 structure is 128×128, and so on.

```js
detect({ groupsFor, add }) {
  for (const group of groupsFor("YOUR-TILE-UUID")) {
    add(group, 23.5, 41, {
      title: "Exact location",
      description: "This marker follows the structure's rotation automatically.",
    });
  }
},
```

Do not rotate the coordinates yourself. `add` handles all four tile rotations
and converts the local point into map coordinates.

If a tile contains several points, call `add` more than once:

```js
detect({ groupsFor, add }) {
  const points = [[12, 18], [45, 50]];
  for (const group of groupsFor("YOUR-TILE-UUID")) {
    for (const [x, y] of points) {
      add(group, x, y, { title: "Pickup" });
    }
  }
},
```

## Detect several tile UUIDs

Use `groups` when one category is detected by a set of UUIDs:

```js
const MY_TILE_UIDS = new Set([
  "FIRST-TILE-UUID",
  "SECOND-TILE-UUID",
]);

// Inside MARKER_TYPES:
{
  kind: "myLocation",
  settingsLabel: "My Locations",
  detailsLabel: "My Location",
  defaultVisible: true,
  iconKind: "dot",
  theme: "my-location",
  color: "#62c8ff",
  detect({ groups, center, add }) {
    for (const group of groups) {
      if (MY_TILE_UIDS.has(group.uid)) {
        add(group, center(group), center(group), { title: "My Location" });
      }
    }
  },
},
```

Put `MY_TILE_UIDS` in `src/markers.js` near the other UUID collections.

## Add or replace an icon

Use a square transparent PNG. A simple one-color silhouette works best because
the viewer recolors the solid part to match the marker's `color`.

1. Put the file in `src/assets/markers/`, for example
   `src/assets/markers/my-location.png`.
2. Import it at the top of `src/markers.js`:

   ```js
   import myLocation from "./assets/markers/my-location.png?inline";
   ```

3. Add it to `MARKER_ICONS`:

   ```js
   export const MARKER_ICONS = {
     // Existing icons...
     myLocation,
   };
   ```

4. Set `iconKind: "myLocation"` on the marker type.

To replace an existing icon, change only its import or its value in
`MARKER_ICONS`. Both the normal marker and its clicked details card update.

`warehouse` and `growlab` are CSS-drawn icons and therefore have no PNG entry.
For new marker types, a PNG is the simplest option.

## Detection helpers

Every `detect` function can use these values:

- `groups`: every unique tile or multi-tile structure in the generated world.
- `groupsFor(uid)`: all occurrences of one tile UUID.
- `center(group)`: the local center coordinate of a group.
- `add(group, x, y, details)`: add a marker at a local point with automatic
  rotation and map-coordinate conversion.
- `groupsByUid`: the underlying UUID-to-groups map, for unusual lookups.
- `cells`: the raw generated cell list, for advanced detection.

A `group` contains `uid`, `size`, `rotation`, `minimumX`, and `minimumY`.
Prefer `groupsFor` and `add` unless you need something unusual.

## Make cached maps refresh

After changing detection, descriptions, rewards, or marker data, increase
`MARKER_DATA_VERSION` near the top of `src/markers.js` by one:

```js
export const MARKER_DATA_VERSION = 11;
```

This tells existing browsers to regenerate marker data for their cached map.
You do not need to change the version for an icon, label, color, or default
visibility-only edit.

## Test the change

```bash
npm ci
npm run build
npm run test:generator -- 1337
```

Then run the local site:

```bash
npm run dev
```

Generate a map containing the target tile, open marker settings, and verify:

- the new category appears once;
- its default visibility is correct;
- the icon and color are readable at normal zoom;
- rotated copies of the tile place the marker correctly;
- the title, description, and optional list appear when clicked;
- an exported HTML viewer shows the same marker and setting.

If an old cached map does not show changed marker data, check that
`MARKER_DATA_VERSION` was increased.
