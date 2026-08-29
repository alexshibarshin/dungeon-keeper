import { Filter, GlProgram, GpuProgram, UniformGroup } from 'pixi.js';

const vertexGl = `
precision highp float;
in vec2 aPosition;
out vec2 vTextureCoord;
uniform vec4 uInputSize;
uniform vec4 uOutputFrame;
uniform vec4 uOutputTexture;

void main(void) {
  vec2 position = aPosition * uOutputFrame.zw + uOutputFrame.xy;
  position.x = position.x * (2.0 / uOutputTexture.x) - 1.0;
  position.y = position.y * (2.0 * uOutputTexture.z / uOutputTexture.y) - uOutputTexture.z;
  gl_Position = vec4(position, 0.0, 1.0);
  vTextureCoord = aPosition * (uOutputFrame.zw * uInputSize.zw);
}`;

const fragmentGl = `
precision highp float;
in vec2 vTextureCoord;
out vec4 finalColor;
uniform sampler2D uTexture;
uniform vec4 uInputSize;
uniform vec4 uInputClamp;
uniform vec4 uOutlineColor;
uniform vec4 uOutlineParams;

float alphaAt(vec2 offset) {
  vec2 uv = clamp(vTextureCoord + offset * uInputSize.zw, uInputClamp.xy, uInputClamp.zw);
  return texture(uTexture, uv).a;
}

float ringAlpha(float radius) {
  float d = radius * 0.70710678;
  float alpha = 0.0;
  alpha = max(alpha, alphaAt(vec2( radius, 0.0)));
  alpha = max(alpha, alphaAt(vec2(-radius, 0.0)));
  alpha = max(alpha, alphaAt(vec2(0.0,  radius)));
  alpha = max(alpha, alphaAt(vec2(0.0, -radius)));
  alpha = max(alpha, alphaAt(vec2( d,  d)));
  alpha = max(alpha, alphaAt(vec2(-d,  d)));
  alpha = max(alpha, alphaAt(vec2( d, -d)));
  alpha = max(alpha, alphaAt(vec2(-d, -d)));
  return alpha;
}

void main(void) {
  vec4 base = texture(uTexture, vTextureCoord);
  float outside = 1.0 - base.a;
  float core = smoothstep(0.04, 0.34, ringAlpha(uOutlineParams.x)) * outside;
  float halo = smoothstep(0.03, 0.38, ringAlpha(uOutlineParams.x * 2.45)) * outside * (1.0 - core) * uOutlineParams.y;
  float outlineAlpha = max(core * uOutlineColor.a, halo * uOutlineColor.a);
  vec3 outlineRgb = uOutlineColor.rgb * (core * uOutlineColor.a + halo * uOutlineColor.a);
  finalColor = vec4(base.rgb + outlineRgb, max(base.a, outlineAlpha));
}`;

const sourceGpu = `
struct GlobalFilterUniforms {
  uInputSize: vec4<f32>,
  uInputPixel: vec4<f32>,
  uInputClamp: vec4<f32>,
  uOutputFrame: vec4<f32>,
  uGlobalFrame: vec4<f32>,
  uOutputTexture: vec4<f32>,
};

struct OutlineUniforms {
  uOutlineColor: vec4<f32>,
  uOutlineParams: vec4<f32>,
};

@group(0) @binding(0) var<uniform> gfu: GlobalFilterUniforms;
@group(0) @binding(1) var uTexture: texture_2d<f32>;
@group(0) @binding(2) var uSampler: sampler;
@group(1) @binding(0) var<uniform> outlineUniforms: OutlineUniforms;

struct VSOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) uv: vec2<f32>,
};

@vertex
fn mainVertex(@location(0) aPosition: vec2<f32>) -> VSOutput {
  var position = aPosition * gfu.uOutputFrame.zw + gfu.uOutputFrame.xy;
  position.x = position.x * (2.0 / gfu.uOutputTexture.x) - 1.0;
  position.y = position.y * (2.0 * gfu.uOutputTexture.z / gfu.uOutputTexture.y) - gfu.uOutputTexture.z;
  let uv = aPosition * (gfu.uOutputFrame.zw * gfu.uInputSize.zw);
  return VSOutput(vec4<f32>(position, 0.0, 1.0), uv);
}

fn alphaAt(uv: vec2<f32>, offset: vec2<f32>) -> f32 {
  let sampleUv = clamp(uv + offset * gfu.uInputSize.zw, gfu.uInputClamp.xy, gfu.uInputClamp.zw);
  return textureSample(uTexture, uSampler, sampleUv).a;
}

fn ringAlpha(uv: vec2<f32>, radius: f32) -> f32 {
  let d = radius * 0.70710678;
  var alpha = 0.0;
  alpha = max(alpha, alphaAt(uv, vec2<f32>( radius, 0.0)));
  alpha = max(alpha, alphaAt(uv, vec2<f32>(-radius, 0.0)));
  alpha = max(alpha, alphaAt(uv, vec2<f32>(0.0,  radius)));
  alpha = max(alpha, alphaAt(uv, vec2<f32>(0.0, -radius)));
  alpha = max(alpha, alphaAt(uv, vec2<f32>( d,  d)));
  alpha = max(alpha, alphaAt(uv, vec2<f32>(-d,  d)));
  alpha = max(alpha, alphaAt(uv, vec2<f32>( d, -d)));
  alpha = max(alpha, alphaAt(uv, vec2<f32>(-d, -d)));
  return alpha;
}

@fragment
fn mainFragment(@location(0) uv: vec2<f32>) -> @location(0) vec4<f32> {
  let base = textureSample(uTexture, uSampler, uv);
  let outside = 1.0 - base.a;
  let thickness = outlineUniforms.uOutlineParams.x;
  let core = smoothstep(0.04, 0.34, ringAlpha(uv, thickness)) * outside;
  let halo = smoothstep(0.03, 0.38, ringAlpha(uv, thickness * 2.45)) * outside * (1.0 - core) * outlineUniforms.uOutlineParams.y;
  let outlineAlpha = max(core * outlineUniforms.uOutlineColor.a, halo * outlineUniforms.uOutlineColor.a);
  let outlineRgb = outlineUniforms.uOutlineColor.rgb * (core * outlineUniforms.uOutlineColor.a + halo * outlineUniforms.uOutlineColor.a);
  return vec4<f32>(base.rgb + outlineRgb, max(base.a, outlineAlpha));
}`;

export function createTierOutlineFilter(color: number, thickness: number, haloStrength: number) {
  const rgb = new Float32Array([((color >> 16) & 0xff) / 255, ((color >> 8) & 0xff) / 255, (color & 0xff) / 255, 1]);
  const uniforms = new UniformGroup({
    uOutlineColor: { value: rgb, type: 'vec4<f32>' },
    uOutlineParams: { value: new Float32Array([thickness, haloStrength, 0, 0]), type: 'vec4<f32>' },
  });
  return new Filter({
    glProgram: GlProgram.from({ vertex: vertexGl, fragment: fragmentGl, name: 'tier-outline-filter' }),
    gpuProgram: GpuProgram.from({ vertex: { source: sourceGpu, entryPoint: 'mainVertex' }, fragment: { source: sourceGpu, entryPoint: 'mainFragment' }, name: 'tier-outline-filter' }),
    resources: { outlineUniforms: uniforms },
    padding: Math.ceil(thickness * 2.45) + 2,
    antialias: 'on',
  });
}
