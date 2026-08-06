import * as THREE from "three";
/** STUB — to be replaced. See src/core/Contracts.js */
export class Level {
  constructor(ctx){ this.ctx = ctx; }
  async init(){}
  update(dt,t){}
  get spawnPoint(){ return new THREE.Vector3(0,1.7,0); }
}
