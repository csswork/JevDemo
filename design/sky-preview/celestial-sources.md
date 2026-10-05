# Celestial rendering references

- Three.js Sky: https://threejs.org/docs/pages/Sky.html — atmospheric solar disc and scattering reference.
- Takram three-geospatial sky shader: https://github.com/takram-design-engineering/three-geospatial/blob/main/packages/atmosphere/src/shaders/sky.glsl — sphere-based lunar illumination and rough diffuse reference.
- NASA CGI Moon Kit: https://svs.gsfc.nasa.gov/4720 — reviewed as a possible real lunar imagery source. No NASA images or elevation maps are included in this implementation.
- Solar System Scope: https://www.solarsystemscope.com/textures/ — reviewed as a CC BY 4.0 texture option. No images from this source are included.

The shipped component is independently written. Its stylized lunar albedo is generated from seeded overlapping basins and crater rings, not an astronomical map. A 256×256 R8 texture with mipmaps uses approximately 85 KiB and replaces per-fragment procedural moon noise. Solar and lunar materials retain the existing two disc draws, cloud ordering, time system and environment/reflection copies. No full-screen bloom pass, downloaded asset or package dependency was added.

`celestial-review.html` magnifies the same materials for inspection; it does not alter apparent sizes in the street.
