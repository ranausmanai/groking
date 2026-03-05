import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

// Create scene
const scene = new THREE.Scene();

// Add basic lighting
const ambientLight = new THREE.AmbientLight(0x404040); // soft white light
scene.add(ambientLight);
const pointLight = new THREE.PointLight(0xffaa00, 1, 100);
pointLight.position.set(5, 5, 5);
pointLight.castShadow = true;
scene.add(pointLight);
const directionalLight = new THREE.DirectionalLight(0xffffff, 0.5);
directionalLight.position.set(1, 1, 1);
directionalLight.castShadow = true;
scene.add(directionalLight);

// Create camera
const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
camera.position.z = 5;

// Create renderer
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(window.devicePixelRatio);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
document.body.appendChild(renderer.domElement);

// Add controls
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.05;

// Create a cube
const geometry = new THREE.BoxGeometry();

// Create procedural texture
const canvas = document.createElement('canvas');
canvas.width = 256;
canvas.height = 256;
const ctx = canvas.getContext('2d');
ctx.fillStyle = 'rgba(255, 0, 0, 0.5)';
ctx.fillRect(0, 0, 128, 128);
ctx.fillStyle = 'rgba(0, 255, 0, 0.5)';
ctx.fillRect(128, 0, 128, 128);
ctx.fillStyle = 'rgba(0, 0, 255, 0.5)';
ctx.fillRect(0, 128, 128, 128);
ctx.fillStyle = 'rgba(255, 255, 0, 0.5)';
ctx.fillRect(128, 128, 128, 128);
const texture = new THREE.CanvasTexture(canvas);

const material = new THREE.MeshStandardMaterial({ 
    map: texture, 
    color: 0x00ff00, 
    emissive: 0x002200, 
    emissiveIntensity: 0.2 
});
const grok = new THREE.Mesh(geometry, material);
grok.castShadow = true;
scene.add(grok);

// Animation loop
function animate() {
    requestAnimationFrame(animate);

    // Get current time
    const time = performance.now() * 0.001; // seconds

    // Keyframe-based movement: simple oscillation
    const keyframes = [
        { time: 0, position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 } },
        { time: 2, position: { x: 2, y: 1, z: 0 }, rotation: { x: 0, y: Math.PI, z: 0 } },
        { time: 4, position: { x: 0, y: 2, z: 0 }, rotation: { x: 0, y: 2 * Math.PI, z: 0 } },
        { time: 6, position: { x: -2, y: 1, z: 0 }, rotation: { x: 0, y: 3 * Math.PI, z: 0 } },
        { time: 8, position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 4 * Math.PI, z: 0 } },
    ];

    // Find current keyframe index
    const loopTime = time % 8; // loop every 8 seconds
    let i = 0;
    while (i < keyframes.length - 1 && keyframes[i + 1].time <= loopTime) i++;

    // Interpolate between keyframes
    const k1 = keyframes[i], k2 = keyframes[(i + 1) % keyframes.length];
    const t = (loopTime - k1.time) / (k2.time - k1.time) || 0;
    const easedT = 0.5 - 0.5 * Math.cos(t * Math.PI); // ease in out

    grok.position.lerpVectors(new THREE.Vector3(k1.position.x, k1.position.y, k1.position.z), new THREE.Vector3(k2.position.x, k2.position.y, k2.position.z), easedT);
    grok.rotation.y = THREE.MathUtils.lerp(k1.rotation.y, k2.rotation.y, easedT);

    // Animate particles
    particles.rotation.y += 0.005;
    particles.rotation.x += 0.002;

    controls.update();

    // Render the scene
    renderer.render(scene, camera);
}

// Add particle system
const particleGeometry = new THREE.BufferGeometry();
const particleCount = 500;
const positions = new Float32Array(particleCount * 3);
for (let i = 0; i < particleCount; i++) {
    positions[i * 3] = (Math.random() - 0.5) * 20;
    positions[i * 3 + 1] = (Math.random() - 0.5) * 20;
    positions[i * 3 + 2] = (Math.random() - 0.5) * 20;
}
particleGeometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
const particleMaterial = new THREE.PointsMaterial({ color: 0xffffff, size: 0.1 });
const particles = new THREE.Points(particleGeometry, particleMaterial);
scene.add(particles);

// Add fog
scene.fog = new THREE.Fog(0x000000, 10, 50);

animate();

// Handle window resize
window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setPixelRatio(window.devicePixelRatio);
});