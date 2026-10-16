# Character model provenance — Gigabyte Stage Phase 1

Phase 1 proves the **stage**, not final cast likenesses. Bespoke cast models
(VRoid-built humans, Blender FADE, MPFB2 builds) are a production step that
drops into `assets/models/` under the same filenames — the stage code does
not care which VRM it loads.

## Current files

| File | What it is | Source | License | Tris | Size |
|---|---|---|---|---|---|
| `misty.vrm` | VRM1_Constraint_Twist_Sample (pixiv's official VRM 1.0 sample character), unmodified | `raw.githubusercontent.com/pixiv/three-vrm/dev/packages/three-vrm/examples/models/VRM1_Constraint_Twist_Sample.vrm` | VRM 1.0 sample license (in-file metadata: © 2022 pixiv Inc., `commercialUsage: "corporation"`, `modification: "allowModificationRedistribution"`, `allowRedistribution: true`, `creditNotation: "unnecessary"`, license URL https://vrm.dev/licenses/1.0/) | 36,470 | 10.77 MB |
| `flowexecutor.vrm` | Same sample model as a **stand-in host**, differentiated at runtime (material tint + 1.035× scale, see `js/stage.js` CONFIG) until the bespoke host model lands | same as above | same as above | 36,470 | 10.77 MB |
| `twist-sample.vrm` | Pristine copy of the sample, kept for reference/re-skinning | same as above | same as above | 36,470 | 10.77 MB |

Notes:
- 36,470 tris is ~6.5k over the blueprint's 30k/character iOS target. The
  sample ships unoptimized (19 images / 13 materials); a Blender/MToon
  optimization pass is part of the bespoke-model step. The stage enforces
  the rest of the iOS budget (pixel-ratio cap + adaptive step-down) today.
- The sample defines **no spring-bone springs**, so hair/cloth physics are
  absent on these stand-ins; procedural idle (blink/breath/sway/nod) is
  fully active. Bespoke models should author spring bones.
- Explicitly avoided per blueprint: MB-Lab output (AGPL-contaminated),
  Ready Player Me (platform shut down Jan 31, 2026), VRoid Hub downloads
  without commercial terms.
