import * as THREE from 'three'

const TEXTURE_KEYS = [
  'map',
  'alphaMap',
  'emissiveMap',
  'aoMap',
  'bumpMap',
  'normalMap',
  'roughnessMap',
  'metalnessMap',
  'envMap',
] as const

function disposeMaterial(mat: THREE.Material): void {
  const anyMat = mat as unknown as Record<string, THREE.Texture | null | undefined>
  for (const key of TEXTURE_KEYS) {
    anyMat[key]?.dispose()
  }
  mat.dispose()
}

/**
 * Recursively frees the GPU-side resources (geometry buffers, material
 * programs, textures) under `root`. Neither dropping a JS reference nor
 * calling `renderer.dispose()` does this on its own -- `renderer.dispose()`
 * only tears down the renderer's own internal caches (render lists,
 * program cache, etc), it does NOT walk the scene disposing individual
 * geometries/materials/textures. Without this, every match_start (a
 * "rematch") that rebuilds the map/soldiers/effects leaks the previous
 * match's VBOs and textures for the lifetime of the tab.
 *
 * THREE.Sprite is special-cased: every Sprite instance in the whole app
 * shares ONE static module-level BufferGeometry (see
 * three/src/objects/Sprite.js) -- disposing it would break every other
 * sprite still alive (other soldiers' name tags, effects' muzzle flashes)
 * for the rest of the session. Only the sprite's own material (and that
 * material's texture, e.g. a soldier's per-instance name canvas) is
 * disposed; its shared geometry is left untouched.
 */
export function disposeObject3D(root: THREE.Object3D): void {
  root.traverse((obj) => {
    if (obj instanceof THREE.Sprite) {
      disposeMaterial(obj.material)
      return
    }
    if (obj instanceof THREE.Mesh || obj instanceof THREE.Line || obj instanceof THREE.Points) {
      obj.geometry.dispose()
      const mat = obj.material
      if (Array.isArray(mat)) mat.forEach(disposeMaterial)
      else disposeMaterial(mat)
    }
  })
}
