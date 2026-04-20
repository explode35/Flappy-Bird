import React, { useRef, useEffect, useCallback, useState } from 'react';
import { GameState } from './types';
import { TILE_SIZE, COLS, ROWS } from './mapData';
import { renderFrame } from './renderer';

interface Props {
  gameState: GameState;
  onTileClick: (row: number, col: number) => void;
  onTowerClick: (id: number) => void;
  selectedTowerId: number | null;
}

export default function GameCanvas({ gameState, onTileClick, onTowerClick, selectedTowerId }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [hoveredTile, setHoveredTile] = useState<{ r: number; c: number } | null>(null);

  const width = COLS * TILE_SIZE;
  const height = ROWS * TILE_SIZE;

  // Render every time state changes
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    renderFrame(ctx, gameState, hoveredTile, selectedTowerId);
  });

  const getCellFromEvent = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const scaleX = width / rect.width;
    const scaleY = height / rect.height;
    const cx = (e.clientX - rect.left) * scaleX;
    const cy = (e.clientY - rect.top) * scaleY;
    return {
      r: Math.floor(cy / TILE_SIZE),
      c: Math.floor(cx / TILE_SIZE),
    };
  }, [width, height]);

  const handleMouseMove = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const { r, c } = getCellFromEvent(e);
    setHoveredTile({ r, c });
  }, [getCellFromEvent]);

  const handleMouseLeave = useCallback(() => setHoveredTile(null), []);

  const handleClick = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const { r, c } = getCellFromEvent(e);
    // Check if a tower was clicked
    const tower = gameState.towers.find(t => t.row === r && t.col === c);
    if (tower) {
      onTowerClick(tower.id);
    } else {
      onTileClick(r, c);
    }
  }, [getCellFromEvent, gameState.towers, onTileClick, onTowerClick]);

  return (
    <canvas
      ref={canvasRef}
      width={width}
      height={height}
      className="block max-w-full max-h-full"
      style={{ imageRendering: 'pixelated', cursor: gameState.placingTower ? 'crosshair' : 'default' }}
      onMouseMove={handleMouseMove}
      onMouseLeave={handleMouseLeave}
      onClick={handleClick}
    />
  );
}
