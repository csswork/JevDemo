export interface LightShaftParameters {
  intensity: number;
  width: number;
  softness: number;
  breakup: number;
  haze: number;
  speed: number;
  spread: number;
  nearFade: number;
  farFade: number;
}
export const LIGHT_SHAFT_DEFAULTS: Readonly<LightShaftParameters> = Object.freeze({
  intensity: .72, width: 1.15, softness: .72, breakup: .58, haze: .24,
  speed: .32, spread: .45, nearFade: 3.5, farFade: 65,
});
export const LIGHT_SHAFT_RANGES: Record<keyof LightShaftParameters, [number, number]> = {
  intensity: [0, 2], width: [.2, 3], softness: [0, 1], breakup: [0, 1], haze: [0, 1],
  speed: [0, 2], spread: [0, 1], nearFade: [.1, 15], farFade: [20, 200],
};

export interface LightShaftSettings extends LightShaftParameters { enabled:boolean; color:string; count:number; area:number; }
export const DEFAULT_LIGHT_SHAFT_SETTINGS:LightShaftSettings={...LIGHT_SHAFT_DEFAULTS,enabled:true,color:'#fff6e3',count:15,area:1};
export const LIGHT_SHAFT_LAYOUT_RANGES={count:[0,48],area:[.25,2]} as const;
export const LIGHT_SHAFT_SETTING_RANGES={...LIGHT_SHAFT_RANGES,...LIGHT_SHAFT_LAYOUT_RANGES};
export function updateLightShaftSettings(current:LightShaftSettings,patch:Partial<LightShaftSettings>):LightShaftSettings {
 const next={...current};
 for(const key of Object.keys(LIGHT_SHAFT_SETTING_RANGES) as Array<keyof typeof LIGHT_SHAFT_SETTING_RANGES>){
  const value=patch[key], [min,max]=LIGHT_SHAFT_SETTING_RANGES[key];
  if(typeof value==='number'&&Number.isFinite(value))next[key]=Math.min(max,Math.max(min,value));
 }
 next.count=Math.round(next.count);
 if(typeof patch.enabled==='boolean')next.enabled=patch.enabled;
 if(typeof patch.color==='string'&&/^#[0-9a-f]{6}$/i.test(patch.color))next.color=patch.color;
 return next;
}
