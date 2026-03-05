import * as THREE from 'https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js';
import { grid } from './gameLogic.js';

export function initRenderer(container, canvasWidth, canvasHeight) {
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x000000);

    const camera = new THREE.PerspectiveCamera(75, canvasWidth / canvasHeight, 0.1, 1000);
    camera.position.set(0, 200, 200);
    camera.lookAt(0, 0, 0);

    const renderer = new THREE.WebGLRenderer();
    renderer.setSize(canvasWidth, canvasHeight);
    container.appendChild(renderer.domElement);

    // Add lights
    const ambientLight = new THREE.AmbientLight(0x404040, 0.6);
    scene.add(ambientLight);
    const directionalLight = new THREE.DirectionalLight(0xffffff, 0.8);
    directionalLight.position.set(100, 100, 100);
    directionalLight.castShadow = true;
    directionalLight.shadow.mapSize.width = 2048;
    directionalLight.shadow.mapSize.height = 2048;
    scene.add(directionalLight);

    // Environment: ground plane
    const planeGeometry = new THREE.PlaneGeometry(canvasWidth, canvasHeight);
    const planeMaterial = new THREE.MeshLambertMaterial({ color: 0x228B22 });
    const plane = new THREE.Mesh(planeGeometry, planeMaterial);
    plane.receiveShadow = true;
    plane.rotation.x = -Math.PI / 2;
    scene.add(plane);

    // Grid helper for environment
    const gridHelper = new THREE.GridHelper(canvasWidth, canvasWidth / grid);
    gridHelper.position.y = 0.1;
    scene.add(gridHelper);

    const rendererObj = {
        scene,
        camera,
        renderer,
        snakeSegments: [],
        foodMesh: null,
        canvasWidth,
        canvasHeight
    };

    return rendererObj;
}

export function updateScene(state, rendererObj) {
    const { scene, snakeSegments, foodMesh, canvasWidth, canvasHeight } = rendererObj;

    // Remove previous snake segments
    snakeSegments.forEach(mesh => scene.remove(mesh));
    snakeSegments.length = 0;

    // Add new snake segments
    for (let segment of state.snake) {
        const geometry = new THREE.BoxGeometry(grid, grid, grid);
        const material = new THREE.MeshLambertMaterial({ color: 0x00ff00, emissive: 0x004400 });
        const cube = new THREE.Mesh(geometry, material);
        cube.position.set(segment.x - canvasWidth / 2, grid / 2, segment.y - canvasHeight / 2);
        scene.add(cube);
        snakeSegments.push(cube);
    }

    // Remove previous food
    if (foodMesh) scene.remove(foodMesh);

    // Add new food
    const foodGeometry = new THREE.SphereGeometry(grid / 2);
    const foodMaterial = new THREE.MeshLambertMaterial({ color: 0xff0000 });
    const foodMeshNew = new THREE.Mesh(foodGeometry, foodMaterial);
    foodMeshNew.position.set(state.food.x - canvasWidth / 2, grid / 2, state.food.y - canvasHeight / 2);
    scene.add(foodMeshNew);
    rendererObj.foodMesh = foodMeshNew;

    // Render the scene
    rendererObj.renderer.render(scene, rendererObj.camera);
}