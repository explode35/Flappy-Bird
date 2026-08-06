import * as THREE from "three";
/** STUB — to be replaced. See src/core/Contracts.js */
export class Physics {
  constructor(ctx){ this.ctx = ctx; }
  async init(){}
  update(dt,t){}
  addStatic(o){}
  build(){}
  raycast(){ return null; }
  moveCapsule(c,d,out){ c.start.add(d); c.end.add(d); if(out){out.grounded=false;} return out; }
  sphereOverlap(){ return []; }
  registerHitbox(){}
  unregisterEnemy(){}
}
