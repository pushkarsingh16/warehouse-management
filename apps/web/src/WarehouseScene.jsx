import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { useUI } from './store';
import { Button } from './ui';

// Instanced geometry follows the authoritative warehouse coordinates. No visual
// remapping: picking paths and bin locations use the same world-space positions.
export default function WarehouseScene({ snapshot, products }) {
  const host = useRef(), runtime = useRef();
  const [failed, setFailed] = useState(false);
  const { selectedBin, selectedProduct, sceneMode, overlay, route, selectBin, cameraRevision } = useUI();
  const bins = snapshot?.bins || [], balances = snapshot?.balances || [];
  useEffect(() => {
    if (!host.current || !bins.length) return;
    let renderer, frame, disposed = false;
    try { renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true }); } catch { setFailed(true); return; }
    const element = host.current;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.7));
    renderer.setClearColor('#f1f5f9', 1);
    renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    element.appendChild(renderer.domElement);
    renderer.domElement.setAttribute('aria-label', 'Interactive warehouse. Drag to orbit, scroll to zoom. Use the bin list below for keyboard access.');
    renderer.domElement.setAttribute('role', 'img');
    const scene = new THREE.Scene();
    scene.add(new THREE.HemisphereLight(0xffffff, 0xcfd8dc, 2.8));
    const light = new THREE.DirectionalLight(0xffffff, 3.2); light.position.set(12, 35, 30); light.castShadow = true; light.shadow.mapSize.set(2048, 2048); Object.assign(light.shadow.camera, { left: -65, right: 65, top: 45, bottom: -45, far: 160 }); light.shadow.bias = -.001; scene.add(light);
    const center = new THREE.Vector3(33, 1.5, 5);
    const camera = new THREE.OrthographicCamera(-40, 40, 22, -22, .1, 300); camera.position.set(70, 47, 67);
    const controls = new OrbitControls(camera, renderer.domElement); controls.target.copy(center); controls.enableDamping = true; controls.dampingFactor = .09; controls.maxPolarAngle = Math.PI / 2.1; controls.minZoom = .55; controls.maxZoom = 7; controls.enablePan = true; controls.update();
    const material = (color, roughness = .75, metalness = .1) => new THREE.MeshStandardMaterial({ color, roughness, metalness });
    const floor = new THREE.Mesh(new THREE.BoxGeometry(70, .5, 17), material('#e2e8f0', .9, 0)); floor.position.set(32, -.5, 5); floor.receiveShadow = true; scene.add(floor);
    const grid = new THREE.GridHelper(70, 35, '#cbd5e1', '#e2e8f0'); grid.position.set(32, -.22, 5); grid.scale.z = 17 / 70; scene.add(grid);
    const lane = new THREE.Mesh(new THREE.BoxGeometry(65, .025, 2.3), material('#dbeafe', .8, 0)); lane.position.set(32, -.20, 1.8); scene.add(lane);
    const racks = [...new Map(bins.map(b => [b.rackCode, b])).values()];
    const dummy = new THREE.Object3D();
    function instances(count, color, transforms, roughness = .75, metalness = .1) {
      const mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), material(color, roughness, metalness), count); mesh.castShadow = true; mesh.receiveShadow = true;
      transforms.forEach((t, i) => { dummy.position.set(...t.p); dummy.scale.set(...t.s); dummy.updateMatrix(); mesh.setMatrixAt(i, dummy.matrix); }); scene.add(mesh); return mesh;
    }
    instances(racks.length * 4, '#1e293b', racks.flatMap(r => [-1.12, 1.12].flatMap(dx => [-1.1, 1.1].map(dz => ({ p: [r.position.x + dx, 2.95, r.position.z + dz], s: [.10, 6.2, .10] })))), .6, .3);
    instances(racks.length * 4, '#64748b', racks.flatMap(r => [0, 2, 4, 6].map(y => ({ p: [r.position.x, y, r.position.z], s: [2.35, .10, 2.3] }))), .7, .2);
    instances(racks.length * 6, '#f59e0b', racks.flatMap(r => [1, 3, 5].flatMap(y => [-1.12, 1.12].map(z => ({ p: [r.position.x, y + .82, r.position.z + z], s: [2.35, .10, .10] })))), .5, .2);
    const boxes = instances(bins.length, '#d4a373', bins.map(b => ({ p: [b.position.x, b.position.y + .85, b.position.z], s: [1.75, 1.5, 1.7] })), .85, 0);
    const outline = new THREE.Mesh(new THREE.BoxGeometry(2.45, .08, 2.4), new THREE.MeshBasicMaterial({ color: '#0284c7', transparent: true, opacity: .75 })); outline.visible = false; scene.add(outline);
    const routes = new THREE.Group(); scene.add(routes);
    const picker = new THREE.Mesh(new THREE.SphereGeometry(.3, 12, 12), material('#0284c7', .4, .2)); picker.visible = false; scene.add(picker);
    const labels = [];
    for (let zone = 0; zone < 4; zone++) {
      const canvas = document.createElement('canvas'); canvas.width = 384; canvas.height = 96;
      const ctx = canvas.getContext('2d'); ctx.font = '600 32px sans-serif'; ctx.fillStyle = '#64748b'; ctx.textAlign = 'center'; ctx.fillText(`ZONE ${String.fromCharCode(65 + zone)}`, 192, 60);
      const texture = new THREE.CanvasTexture(canvas); const plane = new THREE.Mesh(new THREE.PlaneGeometry(7, 1.75), new THREE.MeshBasicMaterial({ map: texture, transparent: true, depthWrite: false })); plane.rotation.x = -Math.PI / 2; plane.position.set(9 + zone * 15, -.14, 9); scene.add(plane); labels.push(texture);
    }
    const raycaster = new THREE.Raycaster(), pointer = new THREE.Vector2(); let down;
    const pointerDown = e => { down = [e.clientX, e.clientY]; };
    const click = e => { if (!down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 5) return; const rect = renderer.domElement.getBoundingClientRect(); pointer.set((e.clientX - rect.left) / rect.width * 2 - 1, -(e.clientY - rect.top) / rect.height * 2 + 1); raycaster.setFromCamera(pointer, camera); const hit = raycaster.intersectObject(boxes)[0]; if (hit) { const b = bins[hit.instanceId]; const balance = runtime.current.balances.find(v => v.binId === b._id); selectBin(b._id, balance?.productId); } };
    renderer.domElement.addEventListener('pointerdown', pointerDown); renderer.domElement.addEventListener('pointerup', click);
    const lost = e => { e.preventDefault(); setFailed(true); }; renderer.domElement.addEventListener('webglcontextlost', lost);
    const resize = () => { const width = element.clientWidth, height = element.clientHeight; if (!width || !height) return; renderer.setSize(width, height); const aspect = width / height; camera.left = -22 * aspect; camera.right = 22 * aspect; camera.top = 22; camera.bottom = -22; camera.updateProjectionMatrix(); };
    const observer = new ResizeObserver(resize); observer.observe(element); resize();
    const reduced = matchMedia('(prefers-reduced-motion: reduce)');
    runtime.current = { scene, camera, controls, boxes, outline, routes, picker, balances, routePoints: [] };
    const animate = time => { if (disposed) return; controls.update(); const points = runtime.current?.routePoints; if (points?.length > 1 && !reduced.matches) { const phase = time / 1800 % (points.length - 1), index = Math.floor(phase); picker.position.lerpVectors(points[index], points[index + 1], phase - index); } renderer.render(scene, camera); frame = requestAnimationFrame(animate); }; frame = requestAnimationFrame(animate);
    return () => { disposed = true; cancelAnimationFrame(frame); observer.disconnect(); controls.dispose(); renderer.domElement.removeEventListener('pointerdown', pointerDown); renderer.domElement.removeEventListener('pointerup', click); renderer.domElement.removeEventListener('webglcontextlost', lost); scene.traverse(o => { o.geometry?.dispose(); if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach(m => m.dispose()); }); labels.forEach(t => t.dispose()); renderer.dispose(); renderer.forceContextLoss(); renderer.domElement.remove(); runtime.current = null; };
  }, [snapshot?.warehouse?._id, snapshot?.warehouse?.layoutVersion, sceneMode === '2d', failed]);
  useEffect(() => { const r = runtime.current; if (!r) return; r.balances = balances; bins.forEach((b, i) => { const balance = balances.find(x => x.binId === b._id); const available = balance ? balance.onHand - balance.reserved : 0; const p = products.find(p => p._id === balance?.productId); const selected = selectedBin === b._id || selectedProduct && selectedProduct === balance?.productId; r.boxes.setColorAt(i, new THREE.Color(selected ? '#0284c7' : overlay === 'stock' && available <= (p?.reorderPoint || 0) ? '#f59e0b' : overlay === 'stock' ? '#10b981' : '#d4a373')); }); if (r.boxes.instanceColor) r.boxes.instanceColor.needsUpdate = true; const b = bins.find(b => b._id === selectedBin); r.outline.visible = Boolean(b); if (b) r.outline.position.set(b.position.x, b.position.y + .03, b.position.z); }, [balances, products, selectedBin, selectedProduct, overlay, snapshot, sceneMode]);
  useEffect(() => { const r = runtime.current; if (!r) return; const b = bins.find(b => b._id === selectedBin); const target = b ? new THREE.Vector3(b.position.x, 2, b.position.z) : new THREE.Vector3(33, 1.5, 5); r.controls.target.copy(target); r.camera.position.copy(target).add(sceneMode === 'top' ? new THREE.Vector3(0, 80, .01) : new THREE.Vector3(37, 45, 62)); r.camera.zoom = b ? 2.5 : 1; r.camera.updateProjectionMatrix(); r.controls.update(); }, [selectedBin, sceneMode, cameraRevision, snapshot?.warehouse?._id]);
  useEffect(() => { const r = runtime.current; if (!r) return; while (r.routes.children.length) { const child = r.routes.children[0]; child.geometry.dispose(); child.material.dispose(); r.routes.remove(child); } const points = (route?.stops || []).flatMap(s => s.coordinates).map(p => new THREE.Vector3(p.x, .2, p.z)); r.routePoints = points; r.picker.visible = points.length > 0; if (points.length) r.picker.position.copy(points[0]); if (points.length > 1) { const curve = new THREE.CatmullRomCurve3(points, false, 'centripetal'); r.routes.add(new THREE.Mesh(new THREE.TubeGeometry(curve, Math.max(20, points.length * 4), .08, 6, false), new THREE.MeshBasicMaterial({ color: '#0284c7' }))); } }, [route, sceneMode]);
  if (failed || sceneMode === '2d') return <div className="map-fallback"><div className="map-caption">{failed ? '3D is unavailable on this device. All bins remain accessible below.' : 'Warehouse bin map · grouped by rack'}</div><div className="bin-map">{bins.map(b => <button key={b._id} className={b._id === selectedBin ? 'selected' : ''} onClick={() => selectBin(b._id, balances.find(x => x.binId === b._id)?.productId)}><span>{b.rackCode}</span><strong>{b.binCode}</strong><small>{balances.filter(x => x.binId === b._id).reduce((n, v) => n + v.onHand - v.reserved, 0)} available</small></button>)}</div></div>;
  return <div ref={host} className="scene-canvas" data-testid="warehouse-scene"/>;
}
