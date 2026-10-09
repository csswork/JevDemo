import type {Shaft} from './lightShafts.ts';
/** Stable, seeded placement: increasing count appends beams instead of reshuffling.
 * Anchors supply radial distance and beam character; golden-angle placement covers
 * the entire clearing, independent of the camera. Area scales horizontal distance.
 */
export function makeLightShaftLayout(anchors:ReadonlyArray<readonly [number,number,number,number]>,count:number,area:number,sunY:number,groundY:(x:number,z:number)=>number):Shaft[]{
 if(!anchors.length)return [];
 const total=Number.isFinite(count)?Math.max(0,Math.min(48,Math.round(count))):anchors.length;
 const scale=Number.isFinite(area)?Math.max(.25,Math.min(2,area)):1;
 const result:Shaft[]=[];
 const noise=(i:number)=>{const v=Math.sin(i*127.1+311.7)*43758.5453;return v-Math.floor(v);};
 for(let i=0;i<total;i++){
  const [ax,az,w,brightness]=anchors[i%anchors.length];
  const extra=i>=anchors.length;
  const radius=Math.hypot(ax,az)*(extra?.85+noise(i*3)*.3:1)*scale;
  // Progressive angular coverage: any prefix spans front, sides and back.
  // A fixed world-space layout avoids shafts chasing the camera.
  const angle=Math.atan2(anchors[0][1],anchors[0][0])+i*2.399963229728653;
  const x=Math.cos(angle)*radius;
  const z=Math.sin(angle)*radius;
  result.push({ground:[x,groundY(x,z),z],length:(12+i%4)/Math.max(.1,sunY),width:w*(extra?.65+noise(i*3+2)*.35:1),intensity:brightness*1.35*(extra?.75:1)});
 }
 return result;
}
