export interface OceanSettings {
 waves:number;roughness:number;foam:number;reflection:number;glitter:number;
 resolution:128|256;
 quality:'low'|'balanced'|'high';
}
export const DEFAULT_OCEAN_SETTINGS:OceanSettings={waves:.55,roughness:.28,foam:.32,reflection:.88,glitter:.6,resolution:128,quality:'balanced'};
export const OCEAN_RANGES={waves:[0,1.5],roughness:[.08,.6],foam:[0,1],reflection:[0,1],glitter:[0,2]} as const;
export function updateOceanSettings(current:OceanSettings,values:Partial<OceanSettings>):OceanSettings{
 const next={...current};
 for(const key of Object.keys(OCEAN_RANGES) as Array<keyof typeof OCEAN_RANGES>){
  const value=values[key],[min,max]=OCEAN_RANGES[key];
  if(value!==undefined&&Number.isFinite(value))next[key]=Math.min(max,Math.max(min,value));
 }
 if(values.resolution===128||values.resolution===256)next.resolution=values.resolution;
 if(values.quality==='low'||values.quality==='balanced'||values.quality==='high')next.quality=values.quality;
 return next;
}
