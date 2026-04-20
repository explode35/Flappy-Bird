import React, { useState, useCallback, useRef } from 'react';
import { GameState, Enemy } from './types';
import { buildGrid, buildPath } from './mapData';
import { tickGame, createTower, TOWER_COST, createEnemy } from './gameLogic';
import { useGameLoop } from './useGameLoop';
import GameCanvas from './GameCanvas';
import Sidebar from './Sidebar';
import './index.css';

const INITIAL_GOLD = 150;
const INITIAL_LIVES = 20;

function makeInitialState(): GameState {
  const grid = buildGrid();
  const path = buildPath();
  return {
    grid,
    path,
    enemies: [],
    towers: [],
    projectiles: [],
    gold: INITIAL_GOLD,
    lives: INITIAL_LIVES,
    wave: 0,
    waveActive: false,
    score: 0,
    gameOver: false,
    placingTower: false,
  };
}

interface SpawnQueue {
  enemies: Enemy[];
  interval: number;
  lastSpawn: number;
}

export default function App() {
  const [gameState, setGameState] = useState<GameState>(makeInitialState);
  const [selectedTowerId, setSelectedTowerId] = useState<number | null>(null);
  const spawnQueueRef = useRef<SpawnQueue | null>(null);

  const handleTick = useCallback((dt: number, now: number) => {
    setGameState(prev => {
      let nextState = { ...prev };

      const sq = spawnQueueRef.current;
      if (sq && sq.enemies.length > 0) {
        if (now - sq.lastSpawn >= sq.interval) {
          const [toSpawn, ...rest] = sq.enemies;
          sq.enemies = rest;
          sq.lastSpawn = now;
          nextState = {
            ...nextState,
            enemies: [...nextState.enemies, toSpawn],
            waveActive: true,
          };
        }
      } else if (sq && sq.enemies.length === 0) {
        spawnQueueRef.current = null;
      }

      if (nextState.gameOver || !nextState.waveActive) return nextState;

      const updates = tickGame(nextState, dt, now);
      return { ...nextState, ...updates };
    });
  }, []);

  useGameLoop(handleTick, true);

  const handleStartWave = useCallback(() => {
    setGameState(prev => {
      if (prev.waveActive || prev.gameOver) return prev;
      const nextWave = prev.wave + 1;
      const count = 8 + nextWave * 4;
      const enemies: Enemy[] = Array.from({ length: count }, () =>
        createEnemy(prev.path, nextWave)
      );
      spawnQueueRef.current = {
        enemies,
        interval: 800,
        lastSpawn: performance.now() - 800,
      };
      return { ...prev, wave: nextWave, waveActive: true };
    });
  }, []);

  const handleBuyTower = useCallback(() => {
    setGameState(prev => {
      if (prev.gold < TOWER_COST || prev.waveActive || prev.gameOver) return prev;
      return { ...prev, placingTower: !prev.placingTower };
    });
  }, []);

  const handleTileClick = useCallback((row: number, col: number) => {
    setGameState(prev => {
      if (!prev.placingTower || prev.gameOver) return prev;
      const tile = prev.grid[row]?.[col];
      if (!tile || tile.type !== 'buildable') return prev;
      if (prev.towers.some(t => t.row === row && t.col === col)) return prev;
      if (prev.gold < TOWER_COST) return prev;
      const tower = createTower(row, col);
      return {
        ...prev,
        towers: [...prev.towers, tower],
        gold: prev.gold - TOWER_COST,
        placingTower: false,
      };
    });
    setSelectedTowerId(null);
  }, []);

  const handleTowerClick = useCallback((id: number) => {
    setSelectedTowerId(prev => prev === id ? null : id);
    setGameState(prev => ({ ...prev, placingTower: false }));
  }, []);

  const handleReset = useCallback(() => {
    spawnQueueRef.current = null;
    setGameState(makeInitialState());
    setSelectedTowerId(null);
  }, []);

  return (
    <div className="flex h-screen bg-gray-950 overflow-hidden">
      <div className="flex-1 flex items-center justify-center overflow-hidden p-2">
        <GameCanvas
          gameState={gameState}
          onTileClick={handleTileClick}
          onTowerClick={handleTowerClick}
          selectedTowerId={selectedTowerId}
        />
      </div>
      <Sidebar
        wave={gameState.wave}
        gold={gameState.gold}
        lives={gameState.lives}
        score={gameState.score}
        waveActive={gameState.waveActive}
        gameOver={gameState.gameOver}
        placingTower={gameState.placingTower}
        onBuyTower={handleBuyTower}
        onStartWave={handleStartWave}
        onReset={handleReset}
      />
    </div>
  );
}
