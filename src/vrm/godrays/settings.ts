export interface GodraySettings {density:number;maxDensity:number;distanceAttenuation:number;raymarchSteps:number;resolutionScale:number;color:string;}
export const GODRAY_DEFAULTS:GodraySettings={density:.022,maxDensity:.5,distanceAttenuation:.2,raymarchSteps:64,resolutionScale:.5,color:'#fff1dc'};

export interface ParkGodraySettings extends GodraySettings {enabled:boolean;sunElevation:number;}
export const DEFAULT_PARK_GODRAYS:ParkGodraySettings={...GODRAY_DEFAULTS,enabled:true,sunElevation:42};
export const GODRAY_RANGES={density:[0,.03],maxDensity:[0,.7],distanceAttenuation:[0,5],raymarchSteps:[16,96],sunElevation:[10,70]} as const;
export function updateGodraySettings(current:ParkGodraySettings,patch:Partial<ParkGodraySettings>):ParkGodraySettings{
 const next={...current};
 for(const key of Object.keys(GODRAY_RANGES) as Array<keyof typeof GODRAY_RANGES>){
  const v=patch[key],[min,max]=GODRAY_RANGES[key];if(typeof v==='number'&&Number.isFinite(v))next[key]=Math.max(min,Math.min(max,v));
 }
 next.raymarchSteps=Math.round(next.raymarchSteps);
 if([.25,.5,1].includes(patch.resolutionScale??0))next.resolutionScale=patch.resolutionScale!;
 if(typeof patch.enabled==='boolean')next.enabled=patch.enabled;
 if(typeof patch.color==='string'&&/^#[0-9a-f]{6}$/i.test(patch.color))next.color=patch.color;
 return next;
}
