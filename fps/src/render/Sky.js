import * as THREE from "three";
/** STUB — to be replaced. See src/core/Contracts.js */
export class Sky {
  constructor(ctx){ this.ctx = ctx; }
  async init(){}
  update(dt,t){}
  get sunDirection(){ return new THREE.Vector3(0.4,0.7,0.3).normalize(); }
}
