const grid = 20;

function createInitialState() {
    return {
        snake: [{ x: 200, y: 200 }],
        direction: { x: 0, y: 0 },
        food: { x: 0, y: 0 },
        score: 0,
        gameRunning: false
    };
}

function randomFood(state, canvasWidth, canvasHeight) {
    state.food.x = Math.floor(Math.random() * (canvasWidth / grid)) * grid;
    state.food.y = Math.floor(Math.random() * (canvasHeight / grid)) * grid;
}

function update(state, canvasWidth, canvasHeight) {
    if (!state.gameRunning) return 'idle';

    const head = {
        x: state.snake[0].x + state.direction.x * grid,
        y: state.snake[0].y + state.direction.y * grid
    };

    // Check wall collision
    if (head.x < 0 || head.x >= canvasWidth || head.y < 0 || head.y >= canvasHeight) {
        return 'gameOver';
    }

    // Check self collision
    for (let segment of state.snake) {
        if (head.x === segment.x && head.y === segment.y) {
            return 'gameOver';
        }
    }

    state.snake.unshift(head);

    // Check food collision
    if (head.x === state.food.x && head.y === state.food.y) {
        state.score++;
        randomFood(state, canvasWidth, canvasHeight);
    } else {
        state.snake.pop();
    }

    return 'continue';
}

function changeDirection(state, newDir) {
    // Prevent reversing into self
    if ((state.direction.x === 0 && newDir.x !== 0) ||
        (state.direction.y === 0 && newDir.y !== 0)) {
        state.direction = newDir;
    }
}

function startGame(state, canvasWidth, canvasHeight) {
    if (!state.gameRunning) {
        state.gameRunning = true;
        randomFood(state, canvasWidth, canvasHeight);
    }
}

function restartGame(state, canvasWidth, canvasHeight) {
    state.snake = [{ x: 200, y: 200 }];
    state.direction = { x: 0, y: 0 };
    state.score = 0;
    state.gameRunning = false;
    randomFood(state, canvasWidth, canvasHeight);
}

export {
    grid,
    createInitialState,
    randomFood,
    update,
    changeDirection,
    startGame,
    restartGame
};