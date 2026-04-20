import React from 'react';
import { TOWER_COST } from './gameLogic';

interface SidebarProps {
  wave: number;
  gold: number;
  lives: number;
  score: number;
  waveActive: boolean;
  gameOver: boolean;
  placingTower: boolean;
  onBuyTower: () => void;
  onStartWave: () => void;
  onReset: () => void;
}

export default function Sidebar({
  wave, gold, lives, score, waveActive, gameOver, placingTower,
  onBuyTower, onStartWave, onReset,
}: SidebarProps) {
  return (
    <div className="flex flex-col gap-4 p-4 bg-gray-900 border-l border-gray-700 w-52 shrink-0">
      <h1 className="text-xl font-bold text-green-400 tracking-wide">Tower Defense</h1>

      {/* Stats */}
      <div className="flex flex-col gap-2 text-sm">
        <Stat icon="🌊" label="Wave" value={wave} />
        <Stat icon="💛" label="Gold" value={gold} />
        <Stat icon="❤️" label="Lives" value={lives} color={lives <= 3 ? 'text-red-400' : 'text-white'} />
        <Stat icon="⭐" label="Score" value={score} />
      </div>

      <hr className="border-gray-700" />

      {/* Build towers */}
      <div>
        <p className="text-xs text-gray-400 uppercase tracking-widest mb-2">Build</p>
        <button
          onClick={onBuyTower}
          disabled={gold < TOWER_COST || waveActive || gameOver || placingTower}
          className={`w-full py-3 px-3 rounded text-sm font-semibold transition-all
            ${placingTower
              ? 'bg-green-600 text-white ring-2 ring-green-400'
              : gold >= TOWER_COST && !waveActive && !gameOver
                ? 'bg-green-700 hover:bg-green-600 text-white'
                : 'bg-gray-700 text-gray-500 cursor-not-allowed'
            }`}
        >
          {placingTower ? 'Click a green tile…' : `Basic Tower (${TOWER_COST}g)`}
        </button>
        {waveActive && !gameOver && (
          <p className="text-xs text-yellow-400 mt-1">Build between waves</p>
        )}
      </div>

      <hr className="border-gray-700" />

      {/* Wave control */}
      {!gameOver ? (
        <button
          onClick={onStartWave}
          disabled={waveActive}
          className={`w-full py-3 rounded font-bold text-sm transition-all
            ${!waveActive
              ? 'bg-blue-600 hover:bg-blue-500 text-white'
              : 'bg-gray-700 text-gray-500 cursor-not-allowed'
            }`}
        >
          {waveActive ? `Wave ${wave} in progress…` : `Start Wave ${wave + 1}`}
        </button>
      ) : (
        <button
          onClick={onReset}
          className="w-full py-3 rounded font-bold text-sm bg-red-700 hover:bg-red-600 text-white"
        >
          Play Again
        </button>
      )}

      <hr className="border-gray-700" />

      <div className="text-xs text-gray-500 space-y-1">
        <p>• Build towers between waves</p>
        <p>• Click tower to see range</p>
        <p>• Don't let enemies reach the base!</p>
      </div>
    </div>
  );
}

function Stat({ icon, label, value, color = 'text-white' }: {
  icon: string; label: string; value: number; color?: string;
}) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-gray-400">{icon} {label}</span>
      <span className={`font-bold ${color}`}>{value}</span>
    </div>
  );
}
