// Context Compiler landing page.
// The hero is a living "map" (three.js, one draw call for the nodes, one for the links). A pinned scroll story drives
// it through four states: build, dark (the session ends), relight (Context Compiler), compile (the map folds into a
// handoff card). Everything else is GSAP: split-text reveals, drawn wires with count-ups, the handoff explorer.
import * as THREE from "./vendor/three/three.module.js";

const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
const small = matchMedia("(max-width: 720px)").matches;
const $ = (s, r = document) => r.querySelector(s), $$ = (s, r = document) => [...r.querySelectorAll(s)];

// ---- the map ------------------------------------------------------------------------------------------------------
const canvas = $("#map");
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: "high-performance" });
renderer.setPixelRatio(Math.min(devicePixelRatio, small ? 1.5 : 2));
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(small ? 62 : 44, 1, 0.1, 200);
camera.position.set(0, 0, small ? 21 : 18);

function prng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const rnd = prng(7), gauss = () => { let u = 0, v = 0; while (!u) u = rnd(); while (!v) v = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };

// Clusters: what you asked for, what failed, what worked, around a core.
const CL = small ? [[-2.2, 4.2, 0], [2.6, 0.8, -1], [-0.6, -4.2, 0.5]] : [[-5.2, 2.6, 0], [5.4, 1.2, -1.2], [-0.4, -3.6, 0.6]];
const N = small ? 120 : 170, pos = [], born = [], seeds = [], targets = [];
// Where the folded card sits: clear of the story text (right on wide screens, high on phones).
const CARD = small ? { x: 0, y: 3.2, g: 0.46 } : { x: 3.6, y: 0.9, g: 0.44 };
for (let i = 0; i < N; i++) {
  const c = i < 22 ? [0, 0, 0] : CL[i % 3], s = i < 22 ? 1.3 : small ? 1.2 : 1.6;
  pos.push([c[0] + gauss() * s, c[1] + gauss() * s * 0.85, c[2] + gauss() * 1.4]);
  born.push(i < 22 ? (i / 22) * 0.25 : 0.2 + rnd() * 0.8);
  seeds.push(rnd());
  // Compile target: a tidy grid, the handoff card.
  const cols = small ? 8 : 14, rows = Math.ceil(N / cols), gx = i % cols, gy = Math.floor(i / cols);
  targets.push([CARD.x + (gx - (cols - 1) / 2) * CARD.g, CARD.y + ((rows - 1) / 2 - gy) * CARD.g, 2]);
}
// Links: each node joins its nearest earlier node, sometimes a second.
const links = [];
for (let i = 1; i < N; i++) {
  const d = pos.slice(0, i).map((p, j) => [Math.hypot(p[0] - pos[i][0], p[1] - pos[i][1], p[2] - pos[i][2]), j]).sort((a, b) => a[0] - b[0]);
  links.push([d[0][1], i]); if (d[1] && rnd() < 0.35) links.push([d[1][1], i]);
}

const U = { uTime: { value: 0 }, uBuild: { value: 0 }, uDark: { value: 0 }, uRelight: { value: 0 }, uCompile: { value: 0 }, uPR: { value: renderer.getPixelRatio() }, uColor: { value: new THREE.Color("#DAEE4C") }, uAlpha: { value: 1 } };
const common = /* glsl */ `
  uniform float uTime, uBuild, uDark, uRelight, uCompile, uPR, uAlpha; uniform vec3 uColor;
  attribute float aBorn; attribute float aSeed; attribute vec3 aTarget;
  float lightAt(vec3 p, float born, float seed){
    float on = smoothstep(born, born + 0.08, uBuild);
    float d = length(p.xy) / 9.0;
    float relit = smoothstep(d - 0.15, d, uRelight);
    float lit = on * mix(1.0 - 0.94 * uDark, 1.0, relit);
    return lit * (0.75 + 0.25 * sin(uTime * 1.6 + seed * 40.0));
  }
  vec3 place(vec3 p, vec3 t, float seed){
    vec3 drift = vec3(sin(uTime * 0.35 + seed * 20.0), cos(uTime * 0.3 + seed * 13.0), 0.0) * 0.12;
    vec3 fall = vec3(0.0, -uDark * (1.0 - uRelight) * (0.6 + seed), 0.0);
    return mix(p + drift + fall, t, smoothstep(0.0, 1.0, clamp(uCompile * 1.3 - seed * 0.3, 0.0, 1.0)));
  }`;
const nodeGeo = new THREE.BufferGeometry();
nodeGeo.setAttribute("position", new THREE.Float32BufferAttribute(pos.flat(), 3));
nodeGeo.setAttribute("aBorn", new THREE.Float32BufferAttribute(born, 1));
nodeGeo.setAttribute("aSeed", new THREE.Float32BufferAttribute(seeds, 1));
nodeGeo.setAttribute("aTarget", new THREE.Float32BufferAttribute(targets.flat(), 3));
const nodes = new THREE.Points(nodeGeo, new THREE.ShaderMaterial({
  uniforms: U, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  vertexShader: common + /* glsl */ `
    varying float vL;
    void main(){ vL = lightAt(position, aBorn, aSeed);
      vec4 mv = modelViewMatrix * vec4(place(position, aTarget, aSeed), 1.0);
      gl_PointSize = (34.0 + 46.0 * aSeed * (1.0 - uCompile)) * uPR * (12.0 / -mv.z) * (0.45 + 0.55 * vL);
      gl_Position = projectionMatrix * mv; }`,
  fragmentShader: /* glsl */ `
    uniform vec3 uColor; uniform float uAlpha; varying float vL;
    void main(){ vec2 q = gl_PointCoord - 0.5; float r = length(q);
      float core = smoothstep(0.09, 0.0, r), halo = exp(-r * r * 13.0) * 0.7;
      gl_FragColor = vec4(uColor * (core * 2.0 + halo), (core * 1.2 + halo) * vL * uAlpha); }`,
}));
scene.add(nodes);

const lp = [], lb = [], ls = [], lt = [];
for (const [a, b] of links) { for (const k of [a, b]) { lp.push(...pos[k]); lb.push(Math.max(born[a], born[b])); ls.push(seeds[k]); lt.push(...targets[k]); } }
const linkGeo = new THREE.BufferGeometry();
linkGeo.setAttribute("position", new THREE.Float32BufferAttribute(lp, 3));
linkGeo.setAttribute("aBorn", new THREE.Float32BufferAttribute(lb, 1));
linkGeo.setAttribute("aSeed", new THREE.Float32BufferAttribute(ls, 1));
linkGeo.setAttribute("aTarget", new THREE.Float32BufferAttribute(lt, 3));
const linkMesh = new THREE.LineSegments(linkGeo, new THREE.ShaderMaterial({
  uniforms: U, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  vertexShader: common + /* glsl */ `varying float vL; void main(){ vL = lightAt(position, aBorn, aSeed) * (1.0 - uCompile); gl_Position = projectionMatrix * modelViewMatrix * vec4(place(position, aTarget, aSeed), 1.0); }`,
  fragmentShader: /* glsl */ `uniform vec3 uColor; uniform float uAlpha; varying float vL; void main(){ gl_FragColor = vec4(uColor, 0.38 * vL * uAlpha); }`,
}));
scene.add(linkMesh);

// The handoff card the map folds into: a rounded frame that draws itself around the grid as it compiles.
const cardFrame = (() => {
  const cols = small ? 8 : 14, rows = Math.ceil(N / cols), gw = CARD.g;
  const w = (cols - 1) * gw + 1.2, h = (rows - 1) * gw + 1.3, r = 0.4, pts = [];
  const shape = new THREE.Shape();
  shape.moveTo(-w / 2 + r, h / 2); shape.lineTo(w / 2 - r, h / 2); shape.quadraticCurveTo(w / 2, h / 2, w / 2, h / 2 - r);
  shape.lineTo(w / 2, -h / 2 + r); shape.quadraticCurveTo(w / 2, -h / 2, w / 2 - r, -h / 2);
  shape.lineTo(-w / 2 + r, -h / 2); shape.quadraticCurveTo(-w / 2, -h / 2, -w / 2, -h / 2 + r);
  shape.lineTo(-w / 2, h / 2 - r); shape.quadraticCurveTo(-w / 2, h / 2, -w / 2 + r, h / 2);
  for (const q of shape.getSpacedPoints(240)) pts.push(new THREE.Vector3(q.x + CARD.x, q.y + CARD.y, 2));
  const g = new THREE.BufferGeometry().setFromPoints(pts);
  const line = new THREE.Line(g, new THREE.LineBasicMaterial({ color: 0xdaee4c, transparent: true, opacity: 0 }));
  line.userData.count = pts.length; return line;
})();

// Faint dust for depth.
{ const r = prng(3), a = []; for (let i = 0; i < (small ? 300 : 700); i++) a.push((r() - 0.5) * 60, (r() - 0.5) * 40, -10 - r() * 30);
  const g = new THREE.BufferGeometry(); g.setAttribute("position", new THREE.Float32BufferAttribute(a, 3));
  scene.add(new THREE.Points(g, new THREE.PointsMaterial({ size: 0.06, color: 0x6d7370, transparent: true, opacity: 0.6, depthWrite: false }))); }

const group = new THREE.Group(); scene.add(group); group.add(nodes, linkMesh, cardFrame); group.scale.setScalar(small ? 1.0 : 1.12);
function resize() { const w = innerWidth, h = innerHeight; renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix(); }
addEventListener("resize", resize); resize();

// Pointer parallax.
const look = { x: 0, y: 0, tx: 0, ty: 0 };
addEventListener("pointermove", (e) => { look.tx = (e.clientX / innerWidth - 0.5) * 2; look.ty = (e.clientY / innerHeight - 0.5) * 2; }, { passive: true });

let visible = true;
const clock = new THREE.Clock();
function frame() {
  requestAnimationFrame(frame);
  if (!visible) return;
  const t = clock.getElapsedTime();
  U.uTime.value = reduce ? 0 : t;
  look.x += (look.tx - look.x) * 0.04; look.y += (look.ty - look.y) * 0.04;
  group.rotation.y = (reduce ? 0 : Math.sin(t * 0.08) * 0.18) + look.x * 0.18;
  group.rotation.x = look.y * 0.1;
  // On wide screens the map sits to the right of the headline until the story begins.
  group.position.x = small ? 0 : THREE.MathUtils.lerp(4.2, 0, U.uDark.value > 0 || U.uRelight.value > 0 ? 1 : storyIn);
  // The frame draws in with the fold.
  const f = Math.max(0, Math.min(1, (U.uCompile.value - 0.35) / 0.65));
  cardFrame.geometry.setDrawRange(0, Math.floor(cardFrame.userData.count * f));
  cardFrame.material.opacity = 0.9 * f * U.uAlpha.value;
  // On a phone the headline sits over the map; keep the map quiet behind it until the story begins.
  U.uAlpha.value = fade.v * (small ? 0.4 + 0.6 * storyIn : 1);
  renderer.render(scene, camera);
}
const fade = { v: 1 }; // scroll fade as the page moves past the story
let storyIn = 0;
requestAnimationFrame(frame);

// ---- GSAP ---------------------------------------------------------------------------------------------------------
addEventListener("DOMContentLoaded", () => {
  const { gsap, ScrollTrigger, SplitText, DrawSVGPlugin, ScrambleTextPlugin } = window;
  gsap.registerPlugin(ScrollTrigger, SplitText, DrawSVGPlugin, ScrambleTextPlugin);
  const APPLE = "cubic-bezier(0.4, 0, 0.2, 1)";
  gsap.defaults({ ease: "power3.out" });

  // Nav turns solid once you leave the hero.
  ScrollTrigger.create({ start: 80, onUpdate: (s) => $("#nav").classList.toggle("solid", s.scroll() > 80) });

  // Hero: the map builds itself, the headline rises line by line.
  if (reduce) { U.uBuild.value = 1; } else {
    gsap.to(U.uBuild, { value: 1, duration: 3.2, ease: "power2.inOut", delay: 0.2 });
    const h = new SplitText(".hero h1", { type: "lines,words", linesClass: "line" });
    gsap.from(h.words, { yPercent: 110, opacity: 0, duration: 1.1, stagger: 0.06, ease: "expo.out", delay: 0.25 });
    gsap.from([".kicker", ".lede", ".hero .install", ".hero .actions"], { y: 26, opacity: 0, duration: 1, stagger: 0.1, delay: 0.7 });
    gsap.from(".hero .cmd", { duration: 1.4, delay: 1.1, scrambleText: { text: "npm install -g --install-links github:swethankreddy/context-compiler", chars: "01ccp-_/:", speed: 0.6 } });
  }

  // Story: pinned; the scroll scrubs the map through build → dark → relight → compile, and the beats crossfade.
  if (!reduce) {
    const beats = $$(".beat");
    const tl = gsap.timeline({ scrollTrigger: { trigger: "#story", start: "top top", end: "bottom bottom", scrub: 0.8,
      onUpdate: (s) => { gsap.set(".progress i", { scaleY: s.progress }); storyIn = Math.min(1, s.progress * 6); } } });
    tl.to(beats[0], { opacity: 1, y: 0, duration: 0.5 }, 0).fromTo(beats[0], { y: 40 }, { y: 0, duration: 0.5 }, 0)
      .to(beats[0], { opacity: 0, y: -30, duration: 0.35 }, 1.1)
      .to(U.uDark, { value: 1, duration: 0.8, ease: APPLE }, 1.1)
      .fromTo(beats[1], { opacity: 0, y: 40 }, { opacity: 1, y: 0, duration: 0.5 }, 1.35)
      .to(beats[1], { opacity: 0, y: -30, duration: 0.35 }, 2.3)
      .to(U.uRelight, { value: 1, duration: 0.9, ease: APPLE }, 2.3)
      .fromTo(beats[2], { opacity: 0, y: 40 }, { opacity: 1, y: 0, duration: 0.5 }, 2.55)
      .to(U.uCompile, { value: 1, duration: 1.0, ease: APPLE }, 3.1)
      .to({}, { duration: 0.3 }, 4.1);
    // The map fades as the page moves on, and stops rendering once it is out of sight.
    gsap.to(fade, { v: 0, ease: "none", scrollTrigger: { trigger: "#how", start: "top bottom", end: "top 30%", scrub: true, onUpdate: (s) => { visible = s.progress < 1; } } });
  }

  // Headings rise line by line as they enter.
  if (!reduce) $$(".section .split").forEach((el) => {
    const s = new SplitText(el, { type: "lines", linesClass: "line" });
    const inner = s.lines.map((l) => { const w = document.createElement("span"); w.style.display = "block"; w.innerHTML = l.innerHTML; l.innerHTML = ""; l.appendChild(w); return w; });
    gsap.from(inner, { yPercent: 105, duration: 1.1, stagger: 0.08, ease: "expo.out", scrollTrigger: { trigger: el, start: "top 85%" } });
    const sub = el.nextElementSibling; if (sub && sub.classList.contains("sub")) gsap.from(sub, { y: 24, opacity: 0, duration: 1, delay: 0.15, scrollTrigger: { trigger: el, start: "top 85%" } });
  });

  // Pipeline: the wire draws across, each stage lands, counts run up to the real numbers.
  const pipe = $(".pipeline");
  const pt = gsap.timeline({ scrollTrigger: { trigger: pipe, start: "top 78%" } });
  if (!reduce) pt.from(".wires .glow", { drawSVG: "0%", duration: 1.8, ease: APPLE }, 0);
  $$(".stage").forEach((st, i) => {
    const c = $(".count", st), to = +c.dataset.to, k = c.dataset.fmt === "k";
    const fmt = (v) => (k ? v.toLocaleString("en-US") : String(Math.round(v)));
    if (reduce) { c.textContent = fmt(to); return; }
    const o = { v: 0 };
    pt.from(st, { y: 30, opacity: 0, duration: 0.8 }, 0.1 + i * 0.28)
      .to(o, { v: to, duration: 1.2, ease: "power2.out", onUpdate: () => (c.textContent = fmt(Math.round(o.v))) }, 0.2 + i * 0.28);
  });

  // Rules and commands step in.
  if (!reduce) {
    gsap.from(".rule", { y: 40, opacity: 0, duration: 0.9, stagger: 0.1, scrollTrigger: { trigger: ".rules", start: "top 82%" } });
    gsap.from(".term li", { x: 30, opacity: 0, duration: 0.8, stagger: 0.09, scrollTrigger: { trigger: ".term", start: "top 80%" } });
    gsap.from(".player", { y: 60, scale: 0.96, opacity: 0, duration: 1.2, scrollTrigger: { trigger: ".player", start: "top 85%" } });
    gsap.from(".cta .mascot", { scale: 0.6, rotate: -8, opacity: 0, duration: 1.2, ease: "elastic.out(1, 0.6)", scrollTrigger: { trigger: ".cta", start: "top 75%" } });
  }

  // Handoff explorer: real sections, lines type in.
  fetch("data/handoff.json").then((r) => r.json()).then((data) => {
    const tabs = $(".tabs"), title = $(".doc-title"), note = $(".doc-note"), list = $(".doc-lines");
    const esc = (s) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);
    const fmt = (s) => esc(s).replace(/`([^`]+)`/g, "<code>$1</code>");
    const show = (i) => {
      const s = data.sections[i];
      $$(".tab", tabs).forEach((b, j) => b.setAttribute("aria-selected", String(i === j)));
      title.textContent = s.name; note.textContent = s.note;
      list.innerHTML = s.lines.slice(0, 7).map((l) => `<li class="${/^\s{2}/.test(l) ? "sub" : ""}">${fmt(l.trim())}</li>`).join("");
      if (!reduce) { gsap.fromTo([title, note], { opacity: 0, y: 8 }, { opacity: 1, y: 0, duration: 0.4 }); gsap.fromTo($$("li", list), { opacity: 0, x: 14 }, { opacity: 1, x: 0, duration: 0.45, stagger: 0.05 }); }
    };
    data.sections.forEach((s, i) => {
      const b = document.createElement("button"); b.type = "button"; b.className = "tab" + (s.name.startsWith("UNKNOWN") ? " unknown" : ""); b.setAttribute("role", "tab");
      b.textContent = s.name.charAt(0) + s.name.slice(1).toLowerCase(); b.addEventListener("click", () => { stop(); show(i); }); tabs.append(b);
    });
    show(0);
    // Tour the sections on its own until someone clicks.
    let k = 0, timer = null; const stop = () => { clearInterval(timer); timer = null; };
    if (!reduce) ScrollTrigger.create({ trigger: ".explorer", start: "top 70%", once: true, onEnter: () => { timer = setInterval(() => { k = (k + 1) % data.sections.length; show(k); }, 3600); } });
  });

  // Copy buttons.
  $$(".install").forEach((box) => { const btn = $(".copy", box); btn.addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(box.dataset.copy); btn.textContent = "Copied"; btn.classList.add("done"); }
    catch { btn.textContent = "Select and copy"; }
    setTimeout(() => { btn.textContent = "Copy"; btn.classList.remove("done"); }, 1800);
  }); });

  // Film.
  const video = $("#video"), player = $(".player");
  $(".play").addEventListener("click", () => { video.play(); });
  video.addEventListener("play", () => player.classList.add("playing"));
  video.addEventListener("pause", () => player.classList.remove("playing"));
});
