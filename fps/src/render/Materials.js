import * as THREE from "three";
/** STUB — to be replaced. See src/core/Contracts.js */
export class Materials {
  constructor(ctx){ this.ctx = ctx; }
  async init(){}
  update(dt,t){}
  get(n){ this._c=this._c||new Map(); if(!this._c.has(n)) this._c.set(n,new THREE.MeshStandardMaterial({color:0x8a8a8a,roughness:0.9,metalness:0})); return this._c.get(n); }
  getTiled(n,sx,sy){ return this.get(n); }
  surfaceOf(m){ return "concrete"; }
}
