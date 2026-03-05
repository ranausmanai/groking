import { changeDirection } from './gameLogic.js';

export function initControls(state) {
    document.addEventListener('keydown', (e) => {
        if (!state.gameRunning) return;
        switch (e.key) {
            case 'ArrowUp':
            case 'w':
            case 'W':
                changeDirection(state, { x: 0, y: -1 });
                break;
            case 'ArrowDown':
            case 's':
            case 'S':
                changeDirection(state, { x: 0, y: 1 });
                break;
            case 'ArrowLeft':
            case 'a':
            case 'A':
                changeDirection(state, { x: -1, y: 0 });
                break;
            case 'ArrowRight':
            case 'd':
            case 'D':
                changeDirection(state, { x: 1, y: 0 });
                break;
        }
    });
}