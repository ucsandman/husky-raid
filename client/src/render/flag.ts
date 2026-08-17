import * as THREE from 'three'
import type { FlagState, Team } from '@riftlane/shared'
import { TEAM_GLOW, TEAM_HULL, type MaterialLibrary } from './materials'
import { mergeMesh } from './worldKit'

/**
 * The capture-the-flag objective, as an actual flag: a mast with a cloth
 * banner that ripples on a vertex-shader wave, a team crest woven into the
 * cloth, and a finial that keeps the silhouette readable against the skyline.
 *
 * Why a shader and not a bone chain: the banner is 140 vertices and there can
 * be four on screen (two stands, a dropped one, a carried one). Displacing it
 * in the vertex stage costs two trig calls per vertex and zero CPU, where a
 * simulated cloth would cost a per-frame solve for something nobody can
 * interact with. The wave is authored, not physical -- gameplay never depends
 * on where a fold lands.
 *
 * The wave is ALSO applied to the normal (analytically, from the same
 * derivative), which is the part that separates a flag from a wobbling
 * billboard: without it the cloth keeps a flat plane's shading and reads as a
 * painted card no matter how much it moves.
 */

const CLOTH_SEGS_X = 14
const CLOTH_SEGS_Y = 8
/** Metres of z-displacement at the free edge. Past ~0.3 the cloth starts to
 * self-intersect visibly at the fold roots on a plane this coarse. */
const WAVE_AMP = 0.22

/** Shared GLSL: one wave definition used by both the position and the normal
 * injection, so the two can never drift out of agreement (a normal derived
 * from a different wave than the displacement is the classic "lit like a flat
 * plane" bug). `f` is 0 at the mast and 1 at the free edge. */
const WAVE_GLSL = /* glsl */ `
uniform float uTime;
uniform float uSpan;
uniform float uAmp;
void riftWave(in vec3 p, out vec3 disp, out float slope) {
  float f = clamp(p.x / uSpan, 0.0, 1.0);
  float amp = uAmp * f * f;
  float phase = 7.0 * f - uTime * 4.2;
  disp = vec3(0.0, amp * 0.42 * cos(phase * 0.8 + p.y * 2.0), amp * sin(phase));
  // d(disp.z)/dx for the surface tangent: product rule over amp(f)*sin(phase).
  slope = (uAmp * 2.0 * f * sin(phase) + amp * 7.0 * cos(phase)) / uSpan;
}
`

/** Cloth material: high roughness plus sheen for the soft edge highlight that
 * makes fabric read as fabric, with the wave injected into stock PBR so it
 * keeps scene lighting, fog and shadows for free.
 *
 * The field and crest textures are COLOURLESS and live on the material library
 * (one pair per match, same lifetime as every other shared texture here);
 * team identity is `color` x field and `emissive` x crest. That is what lets
 * the banner a carrier wears be re-tinted the instant they pick up either
 * team's flag, exactly like the prop it replaces. */
function makeClothMaterial(lib: MaterialLibrary, team: Team, span: number): THREE.MeshPhysicalMaterial {
  const mat = new THREE.MeshPhysicalMaterial({
    color: TEAM_HULL[team],
    map: lib.clothFieldTex,
    emissiveMap: lib.clothCrestTex,
    emissive: TEAM_GLOW[team],
    // Enough self-light for the crest to stay a readable team colour across
    // the map at dusk; the cloth field itself still needs the sun.
    emissiveIntensity: 1.5,
    roughness: 0.92,
    metalness: 0,
    // Sheen at 1.0 with a bright team sheenColor washed the whole banner out
    // to near-white under the dusk hemisphere -- it stopped reading as a team
    // colour at all. Halved, and the lobe tint pulled most of the way to
    // white, so the sheen is an edge highlight rather than a second light.
    sheen: 0.5,
    sheenRoughness: 0.6,
    sheenColor: new THREE.Color(0xdfe6f5),
    side: THREE.DoubleSide,
  })
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = { value: 0 }
    shader.uniforms.uSpan = { value: span }
    shader.uniforms.uAmp = { value: WAVE_AMP }
    mat.userData.shader = shader
    shader.vertexShader = WAVE_GLSL + shader.vertexShader
      .replace(
        '#include <beginnormal_vertex>',
        `#include <beginnormal_vertex>
         vec3 waveN; float waveSlope;
         riftWave(position, waveN, waveSlope);
         objectNormal = normalize(vec3(-waveSlope, 0.0, sign(objectNormal.z + 1e-4)));`
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
         vec3 waveD; float waveDSlope;
         riftWave(position, waveD, waveDSlope);
         transformed += waveD;`
      )
  }
  // Without this three can hand back a program compiled from an un-injected
  // MeshPhysicalMaterial and silently drop the wave.
  mat.customProgramCacheKey = () => 'rift-flag-cloth'
  return mat
}

/**
 * Builds one flag at the origin, mast base at y=0, facing +z.
 *
 * `scale` shrinks the whole rig for the version strapped to a carrier's back;
 * the wave amplitude rides the group scale with it, so a small flag ripples
 * proportionally rather than thrashing.
 *
 * Disposal is the caller's existing disposeObject3D walk (the map group's, or
 * the soldier group's) -- it already frees per-mesh materials and their maps,
 * which covers the cloth material and its crest canvas.
 */
export function makeFlag(lib: MaterialLibrary, team: Team, scale = 1): THREE.Group {
  const group = new THREE.Group()
  group.name = `flag${team}`
  // Mast, cloth and finial live on an inner rig so the DROPPED lean can tilt
  // them without tilting the locator shaft, which has to stay world-vertical
  // to read as a marker rather than as a fallen beam.
  const rig = new THREE.Group()
  rig.name = 'flagRig'
  group.add(rig)

  // 1.9 x 1.3 is a normal flag's ~1.45:1, hoisted so the head of the cloth
  // sits just under the mast top. Read at 50m is what sizes it: at the first
  // pass's 1.6 x 1.0 the banner was a smudge from across the lane.
  const span = 1.9
  const cloth = new THREE.Mesh(
    new THREE.PlaneGeometry(span, 1.3, CLOTH_SEGS_X, CLOTH_SEGS_Y).translate(span / 2, 2.6, 0),
    makeClothMaterial(lib, team, span)
  )
  cloth.name = 'flagCloth'
  cloth.castShadow = true
  cloth.userData.cloth = true // effects.tickMapPulse drives uTime off this tag
  rig.add(cloth)

  // Mast: a tapered pole plus the two collars the cloth hangs from, merged
  // into one draw call against the library's shared metal.
  const mast = mergeMesh(
    [
      new THREE.CylinderGeometry(0.035, 0.052, 3.3, 8).translate(0, 1.65, 0),
      new THREE.CylinderGeometry(0.055, 0.055, 0.07, 8).translate(0, 3.22, 0),
      new THREE.CylinderGeometry(0.055, 0.055, 0.07, 8).translate(0, 2.22, 0),
    ],
    lib.trim,
    'flagMast'
  )
  if (mast) {
    mast.castShadow = true
    rig.add(mast)
  }

  // Finial and locator shaft are world-flag only. Both use LIBRARY-SHARED
  // team materials, which a carrier's flag must never touch: the banner on
  // your back is the ENEMY flag, so it gets re-tinted per pickup, and tinting
  // a shared material would repaint every other team-coloured prop on the map.
  // The carried version is mast + cloth, which is all that reads at that size.
  if (scale === 1) {
    // Finial: the spike that stops the top of the silhouette from reading as a
    // cut-off stick, and the one part allowed to glow hard.
    const finial = new THREE.Mesh(new THREE.ConeGeometry(0.085, 0.34, 8), lib.teamGlow(team))
    finial.position.y = 3.52
    finial.userData.pulse = true
    finial.userData.baseEmissive = 1.6
    rig.add(finial)

    // Locator shaft: what makes a DROPPED flag findable. A flag knocked loose
    // mid-lane had no marker at all, so the only way to find it was to run
    // over it. Travels with the flag because it is a child of the outer group,
    // and stays OUT of the rig so a dropped flag's lean never tips it over.
    //
    // Deliberately thin and faint. The 26m pillar this replaces (worldKit's
    // old beacon) was 0.3-0.62m of additive cone, and standing anywhere near
    // it filled a third of the screen with a pale wedge -- an additive column
    // wide enough to be obvious up close is wide enough to be an artifact.
    // Width is what makes an additive column an artifact, not brightness -- so
    // this stays narrow and buys its visibility back with opacity instead.
    const shaft = new THREE.Mesh(
      new THREE.CylinderGeometry(0.06, 0.15, 8, 8, 1, true),
      lib.additive(TEAM_GLOW[team], 0.1)
    )
    shaft.position.y = 4
    shaft.renderOrder = 4
    group.add(shaft)
  }

  group.scale.setScalar(scale)
  return group
}

/** How far a dropped flag leans. Enough to read as "loose on the ground" from
 * across the map without laying it flat, which would hide the cloth. */
const DROPPED_TILT = 0.62

/**
 * Points each team's flag at its authoritative state from the snapshot.
 *
 * Before this existed the client drew NO flag: the objective was an abstract
 * beacon that never moved, and a flag dropped in the open was completely
 * invisible -- you could only find it by running over it. `pos` is
 * server-authoritative for all three states, so this is a straight read.
 *
 * A carried flag hides here and shows on the carrier's back instead (see
 * soldier.ts), so exactly one copy is ever on screen per team.
 *
 * ponytail: getObjectByName walks the map group twice a frame (~60 nodes).
 * Cache the two refs if a much larger map ever makes that measurable.
 */
export function syncFlags(root: THREE.Object3D, flags: readonly FlagState[]): void {
  for (let i = 0; i < flags.length; i++) {
    const group = root.getObjectByName(`flag${i}`)
    if (!group) continue
    const flag = flags[i]
    group.visible = flag.state !== 'carried'
    group.position.set(flag.pos.x, flag.pos.y, flag.pos.z)
    const rig = group.getObjectByName('flagRig')
    if (rig) rig.rotation.z = flag.state === 'dropped' ? DROPPED_TILT : 0
  }
}
