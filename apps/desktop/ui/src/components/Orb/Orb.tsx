import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { audioBus } from '@/components/voice/audioBus';

export type OrbVoiceState = 'idle' | 'listening' | 'thinking' | 'answering';

const SIZE = 240;
const BARS = 96;

const PALETTE: Record<OrbVoiceState, [string, string, string]> = {
  idle: ['#67D9FF', '#42E8E0', '#BFF6FF'],
  listening: ['#42E8E0', '#67D9FF', '#D8FBFF'],
  thinking: ['#7FA8C9', '#8FD8E8', '#D5EEF5'],
  answering: ['#2FA8C9', '#63F2B0', '#FFFFFF'],
};

const VERT = /* glsl */ `
uniform float uTime;
uniform float uLevel;
varying vec3 vN;
void main() {
  vec3 p = position;
  float d = sin(p.x * 3.0 + uTime * 1.2) * sin(p.y * 3.0 + uTime) * sin(p.z * 3.0 + uTime * 0.8);
  p += normal * d * (0.02 + uLevel * 0.12);
  vN = normalize(normalMatrix * normal);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}`;

const FRAG = /* glsl */ `
uniform vec3 uA;
uniform vec3 uB;
uniform vec3 uC;
uniform float uTime;
varying vec3 vN;
void main() {
  float g = vN.y * 0.5 + 0.5;
  float s = sin(vN.x * 2.0 + uTime * 0.6) * 0.5 + 0.5;
  vec3 col = mix(uA, uB, g);
  col = mix(col, uC, s * 0.45 * (1.0 - g));
  float fres = pow(1.0 - max(vN.z, 0.0), 2.5);
  col += fres * 0.35;
  gl_FragColor = vec4(col, 1.0);
}`;

export function Orb({ state, size = SIZE }: { state: OrbVoiceState; size?: number }) {
  const host = useRef<HTMLDivElement>(null);
  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    renderer.setSize(size, size);
    el.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const camera = new THREE.OrthographicCamera(-1.8, 1.8, 1.8, -1.8, 0.1, 10);
    camera.position.z = 5;

    const uniforms = {
      uTime: { value: 0 },
      uLevel: { value: 0 },
      uA: { value: new THREE.Color(PALETTE.idle[0]) },
      uB: { value: new THREE.Color(PALETTE.idle[1]) },
      uC: { value: new THREE.Color(PALETTE.idle[2]) },
    };
    const sphereGeo = new THREE.SphereGeometry(1, 64, 64);
    const sphereMat = new THREE.ShaderMaterial({
      uniforms,
      vertexShader: VERT,
      fragmentShader: FRAG,
    });
    const sphere = new THREE.Mesh(sphereGeo, sphereMat);
    scene.add(sphere);

    const barGeo = new THREE.PlaneGeometry(0.02, 1);
    const barMat = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.5 });
    const ring = new THREE.InstancedMesh(barGeo, barMat, BARS);
    const mint = new THREE.Color('#63F2B0');
    const blue = new THREE.Color('#2F7FC9');
    const tmp = new THREE.Color();
    for (let i = 0; i < BARS; i++) {
      const x = i / BARS;
      const m = x < 0.5 ? x * 2 : (1 - x) * 2;
      ring.setColorAt(i, tmp.copy(mint).lerp(blue, m));
    }
    if (ring.instanceColor) ring.instanceColor.needsUpdate = true;
    scene.add(ring);

    const target = {} as Record<OrbVoiceState, THREE.Color[]>;
    (Object.keys(PALETTE) as OrbVoiceState[]).forEach((k) => {
      target[k] = PALETTE[k].map((h) => new THREE.Color(h));
    });

    const dummy = new THREE.Object3D();
    const hs = new Float32Array(BARS).fill(0.03);
    const R = 1.28;
    let smooth = 0;
    const t0 = performance.now();

    const frame = () => {
      if (document.hidden) return;
      const t = (performance.now() - t0) / 1000;
      const st = stateRef.current;
      const active = st === 'listening' || st === 'answering';

      smooth += ((active ? audioBus.level : 0) - smooth) * 0.15;
      uniforms.uTime.value = t;
      uniforms.uLevel.value = smooth;
      uniforms.uA.value.lerp(target[st][0], 0.06);
      uniforms.uB.value.lerp(target[st][1], 0.06);
      uniforms.uC.value.lerp(target[st][2], 0.06);
      sphere.scale.setScalar(1 + smooth * 0.08);

      barMat.opacity += ((active ? 1 : 0.5) - barMat.opacity) * 0.1;
      ring.rotation.z = st === 'thinking' ? t * 0.6 : t * 0.05;

      for (let i = 0; i < BARS; i++) {
        const x = i / BARS;
        const m = x < 0.5 ? x * 2 : (1 - x) * 2;
        let goal = 0.03;
        if (active) goal += (audioBus.bins[Math.floor(m * 40)] / 255) * 0.38;
        else if (st === 'thinking') goal += Math.max(0, Math.sin(x * Math.PI * 4 - t * 3)) * 0.1;
        hs[i] += (goal - hs[i]) * 0.25;

        const a = x * Math.PI * 2;
        dummy.position.set(Math.cos(a) * (R + hs[i] / 2), Math.sin(a) * (R + hs[i] / 2), 0);
        dummy.rotation.z = a - Math.PI / 2;
        dummy.scale.set(1, hs[i], 1);
        dummy.updateMatrix();
        ring.setMatrixAt(i, dummy.matrix);
      }
      ring.instanceMatrix.needsUpdate = true;
      renderer.render(scene, camera);
    };
    renderer.setAnimationLoop(frame);

    return () => {
      renderer.setAnimationLoop(null);
      sphereGeo.dispose();
      sphereMat.dispose();
      barGeo.dispose();
      barMat.dispose();
      ring.dispose();
      renderer.dispose();
      if (renderer.domElement.parentElement === el) el.removeChild(renderer.domElement);
    };
  }, [size]);

  return (
    <div
      ref={host}
      className="apollo-orb"
      style={{ width: size, height: size }}
      aria-hidden
    />
  );
}

/** Mapea el orbState real del store al estado visual del orbe. */
export function toOrbVoiceState(s: string): OrbVoiceState {
  switch (s) {
    case 'listening':
    case 'confirming':
      return 'listening';
    case 'thinking':
    case 'focusing':
    case 'focus':
      return 'thinking';
    case 'speaking':
    case 'responding':
      return 'answering';
    default:
      return 'idle';
  }
}
