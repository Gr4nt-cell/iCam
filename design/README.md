# iCam · Liquid Glass UI

This update gives iCam a floating capture dock, cool silver-blue glass with edge highlights, a unified mode selector, rounded gallery tile, and matching Pro, Looks, settings, permission and gallery surfaces. The photo shutter remains white and the recording button remains red. Settings gain grouped cards, a close button and horizontally scrollable option controls on narrow displays. The capture dock and panels have bounded widths on larger displays.

The persistent center-square guide is removed; the temporary tap-to-focus ring is retained.

The camera feed, captured media, native CameraX module, image processing, capture modes, gestures, permissions, saved settings and existing control callbacks remain intact. The glass tint is a UI overlay only. No dependencies or signing configuration changed.

## Files

- `figma-liquid-glass.js`: standalone editable Figma Scripter import. Four screen references (Photo, Recording, Pro and Settings), reusable vector icon controls and five color variables. Uses local Roboto when available, otherwise Inter. No flattened UI screenshots are imported.
- `liquid-glass-reference.png` / `.svg`: design reference rendered from that import with a local mock of Figma's scene graph; not a screenshot of the running Android app. Abstract scenery represents a live camera feed. Settings continues scrolling below the visible area.
- `../scripts/check-ui-preservation.cjs`: static audit of existing control bindings and native camera props against a base git revision.

## Apply the source update

On a clean checkout of `Gr4nt-cell/iCam` at the base revision in the package's `APPLY.md`, run `git switch -c gpt`, then `git apply --check icam-liquid-glass.patch` and `git apply icam-liquid-glass.patch`. Alternatively copy the `source/` files over the matching repository paths. Do not use both methods. Install the app's existing dependencies and run `npm run typecheck`.

## Import into Figma

The project file is https://www.figma.com/design/ruVinYVPdJkugSfcrDmIOS . It was created successfully, but canvas reads and edits are blocked by the account's Figma MCP Collab-seat tool limit. The screens have **not** been written to that canvas.

Open that file in Figma, run the Scripter plugin, paste the full contents of `figma-liquid-glass.js` and run once. This creates a new page named `iCam · Liquid Glass`; repeating the import creates another page. The source script was executed against a local mock to verify structure and render the reference. A real Figma import remains unverified while the account limit is active.

## Validation

- `npm run typecheck`: passed.
- `node scripts/check-ui-preservation.cjs <base-revision>`: passed; 149 original control bindings retained, native camera props and capture state/handlers unchanged.
- `git diff --check`: passed.
- Design import: local mock execution and visual inspection of all four references passed.

No physical device or emulator camera test was available. Verify launch, permissions, lens selection/pinch/zoom dial, every hardware-supported capture mode, focus/exposure, capture timer, flash, recording/pause/flip, gallery comparison, filters, Pro settings, dual PIP, palm shutter and persisted settings on a device. Also check glass readability and performance over bright/moving previews, narrow screens, large text and landscape.

## Publishing status

Local branch: `gpt`. GitHub rejected branch creation with `403 Resource not accessible by integration`; no source changes have been pushed. The package excludes credentials and signing material.
