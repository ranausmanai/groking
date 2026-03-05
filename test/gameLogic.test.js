const assert = require('assert');
const { createInitialState, update, changeDirection, startGame, restartGame, grid } = require('../gameLogic.js');

const canvasWidth = 400;
const canvasHeight = 400;

describe('Snake Game Logic', () => {
    let state;

    beforeEach(() => {
        state = createInitialState();
    });

    describe('createInitialState', () => {
        it('should create initial game state', () => {
            assert.deepStrictEqual(state.snake, [{ x: 200, y: 200 }]);
            assert.deepStrictEqual(state.direction, { x: 0, y: 0 });
            assert.deepStrictEqual(state.food, { x: 0, y: 0 });
            assert.strictEqual(state.score, 0);
            assert.strictEqual(state.gameRunning, false);
        });
    });

    describe('update', () => {
        it('should not update if game not running', () => {
            const result = update(state, canvasWidth, canvasHeight);
            assert.strictEqual(result, 'idle');
            assert.deepStrictEqual(state.snake, [{ x: 200, y: 200 }]);
        });

        it('should move snake right', () => {
            state.gameRunning = true;
            state.direction = { x: 1, y: 0 };
            const result = update(state, canvasWidth, canvasHeight);
            assert.strictEqual(result, 'continue');
            assert.deepStrictEqual(state.snake, [{ x: 220, y: 200 }, { x: 200, y: 200 }]);
        });

        it('should detect wall collision', () => {
            state.gameRunning = true;
            state.direction = { x: 0, y: -1 };
            state.snake[0] = { x: 200, y: 0 };
            const result = update(state, canvasWidth, canvasHeight);
            assert.strictEqual(result, 'gameOver');
        });

        it('should detect self collision', () => {
            state.gameRunning = true;
            state.direction = { x: 0, y: 1 };
            state.snake = [{ x: 200, y: 200 }, { x: 200, y: 220 }, { x: 200, y: 200 }];
            const result = update(state, canvasWidth, canvasHeight);
            assert.strictEqual(result, 'gameOver');
        });

        it('should grow snake and increase score on food collision', () => {
            state.gameRunning = true;
            state.direction = { x: 1, y: 0 };
            state.food = { x: 220, y: 200 };
            const initialLength = state.snake.length;
            const result = update(state, canvasWidth, canvasHeight);
            assert.strictEqual(result, 'continue');
            assert.strictEqual(state.score, 1);
            assert.strictEqual(state.snake.length, initialLength + 1);
            assert.deepStrictEqual(state.snake[0], { x: 220, y: 200 });
        });
    });

    describe('changeDirection', () => {
        it('should change direction to right', () => {
            changeDirection(state, { x: 1, y: 0 });
            assert.deepStrictEqual(state.direction, { x: 1, y: 0 });
        });

        it('should not reverse direction', () => {
            state.direction = { x: 1, y: 0 };
            changeDirection(state, { x: -1, y: 0 });
            assert.deepStrictEqual(state.direction, { x: 1, y: 0 });
        });
    });

    describe('startGame', () => {
        it('should start the game and spawn food', () => {
            startGame(state, canvasWidth, canvasHeight);
            assert.strictEqual(state.gameRunning, true);
            // Food should be set, but random, so just check it's not initial
            assert.notDeepStrictEqual(state.food, { x: 0, y: 0 });
        });
    });

    describe('restartGame', () => {
        it('should reset the game state', () => {
            state.gameRunning = true;
            state.score = 10;
            state.snake = [{ x: 300, y: 300 }];
            restartGame(state, canvasWidth, canvasHeight);
            assert.strictEqual(state.score, 0);
            assert.strictEqual(state.gameRunning, false);
            assert.deepStrictEqual(state.snake, [{ x: 200, y: 200 }]);
            assert.deepStrictEqual(state.direction, { x: 0, y: 0 });
        });
    });
});