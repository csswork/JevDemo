const clamp=(value:number,min:number,max:number)=>Math.min(max,Math.max(min,value));
export interface SkySettings {
  coverage:number;
  cirrus:number;
  moonPhase:number|null;
  windDirection:number;
  windSpeed:number;
  quality:'low'|'balanced'|'high';
}
export const DEFAULT_SKY_SETTINGS:SkySettings={coverage:.32,cirrus:.4,moonPhase:null,windDirection:27,windSpeed:2,quality:'balanced'};
/** Shared validation for runtime callers and debug controls. */
export function updateSkySettings(current:SkySettings,values:Partial<SkySettings>):SkySettings{
 const next={...current};
 for(const key of ['coverage','cirrus','windDirection','windSpeed'] as const){
  const value=values[key];if(value!==undefined&&Number.isFinite(value))
   next[key]=clamp(value,0,key==='windDirection'?360:key==='windSpeed'?12:1);
 }
 if(values.moonPhase===null)next.moonPhase=null;
 else if(values.moonPhase!==undefined&&Number.isFinite(values.moonPhase))next.moonPhase=clamp(values.moonPhase,0,1);
 if(values.quality==='low'||values.quality==='balanced'||values.quality==='high')next.quality=values.quality;
 return next;
}
