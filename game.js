// Basic game logic setup with Three.js
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
const renderer = new THREE.WebGLRenderer({ canvas: document.getElementById('canvas') });

// Set renderer size
renderer.setSize(window.innerWidth, window.innerHeight);

camera.position.set(10, 10, 10);
camera.lookAt(0, 0, 0);

// Add lighting for 3D effect
const light = new THREE.DirectionalLight(0xffffff, 1);
light.position.set(1, 1, 1).normalize();
scene.add(light);

// Ambient light for base illumination
const ambientLight = new THREE.AmbientLight(0x404040, 0.5);
scene.add(ambientLight);

// Materials for snake and food
const snakeMaterial = new THREE.MeshLambertMaterial({ color: 0x00ff00 });
const foodMaterial = new THREE.MeshLambertMaterial({ color: 0xff0000 });

let snakeMeshes = [];
let foodMesh;

function updateMeshes() {
    // Remove old snake meshes
    snakeMeshes.forEach(mesh => scene.remove(mesh));
    snakeMeshes = [];

    // Add snake segment cubes
    snake.positions.forEach(pos => {
        const geometry = new THREE.BoxGeometry(1, 1, 1);
        const mesh = new THREE.Mesh(geometry, snakeMaterial);
        mesh.position.set(pos[0] - gridWidth / 2, pos[1] - gridHeight / 2, 0);
        scene.add(mesh);
        snakeMeshes.push(mesh);
    });

    // Remove old food mesh
    if (foodMesh) scene.remove(foodMesh);

    // Add food cube
    const foodGeometry = new THREE.BoxGeometry(1, 1, 1);
    foodMesh = new THREE.Mesh(foodGeometry, foodMaterial);
    foodMesh.position.set(food[0] - gridWidth / 2, food[1] - gridHeight / 2, 0);
    scene.add(foodMesh);
}

// Animation and game loop
let lastMoveTime = 0;
const moveInterval = 500;

function animate(currentTime = 0) {
    requestAnimationFrame(animate);
    if (currentTime - lastMoveTime > moveInterval && gameRunning) {
        moveSnake();
        if (checkCollision()) {
            gameRunning = false;
            document.getElementById('gameOver').style.display = 'block';
        }
        lastMoveTime = currentTime;
    }
    updateMeshes();
    renderer.render(scene, camera);
}
animate();

// Snake game logic
const gridWidth = 20;
const gridHeight = 20;

let gameRunning = true;

// Keyboard event listeners for direction changes
document.addEventListener('keydown', (e) => {
    if (!gameRunning) return;
    switch (e.key) {
        case 'ArrowUp':
            if (snake.direction[1] !== -1) snake.direction = [0, 1];
            break;
        case 'ArrowDown':
            if (snake.direction[1] !== 1) snake.direction = [0, -1];
            break;
        case 'ArrowLeft':
            if (snake.direction[0] !== 1) snake.direction = [-1, 0];
            break;
        case 'ArrowRight':
            if (snake.direction[0] !== -1) snake.direction = [1, 0];
            break;
    }
});

let snake = {
    positions: [[10, 10]], // initial position
    direction: [0, 1] // initial direction (up)
};

let food = [5, 5]; // initial food position
let score = 0;

function moveSnake() {
    let head = [snake.positions[0][0] + snake.direction[0], snake.positions[0][1] + snake.direction[1]];
    snake.positions.unshift(head);
    if (head[0] === food[0] && head[1] === food[1]) {
        score++;
        document.getElementById('score').innerText = `Score: ${score}`;
        generateFood();
    } else {
        snake.positions.pop();
    }
}

function generateFood() {
    do {
        food[0] = Math.floor(Math.random() * gridWidth);
        food[1] = Math.floor(Math.random() * gridHeight);
    } while (snake.positions.some(pos => pos[0] === food[0] && pos[1] === food[1]));
}

function checkCollision() {
    let head = snake.positions[0];
    // Wall collision
    if (head[0] < 0 || head[0] >= gridWidth || head[1] < 0 || head[1] >= gridHeight) {
        return true;
    }
    // Self collision
    for (let i = 1; i < snake.positions.length; i++) {
        if (head[0] === snake.positions[i][0] && head[1] === snake.positions[i][1]) {
            return true;
        }
    }
    return false;
}

// Function to change direction (to be called from controls)
function changeDirection(newDirection) {
    snake.direction = newDirection;
}