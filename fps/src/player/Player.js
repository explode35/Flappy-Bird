import * as THREE from "three";
/** STUB — to be replaced. See src/core/Contracts.js */
export class Player {
  constructor(ctx){ this.ctx = ctx; }
  async init(){}
  update(dt,t){}
  get position(){ return this.ctx.camera.position; }
}
