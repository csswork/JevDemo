import {DEFAULT_LIGHT_SHAFT_SETTINGS,updateLightShaftSettings,type LightShaftSettings} from '../scenes/lightShaftSettings.ts';
import {DEFAULT_SKY_SETTINGS,updateSkySettings,type SkySettings} from './skySettings.ts';
import {DEFAULT_OCEAN_SETTINGS,updateOceanSettings,type OceanSettings} from '../ocean/oceanSettings.ts';
export interface SceneSettings extends SkySettings {ocean:OceanSettings;lightShafts:LightShaftSettings;}
export const DEFAULT_SCENE_SETTINGS:SceneSettings={...DEFAULT_SKY_SETTINGS,ocean:{...DEFAULT_OCEAN_SETTINGS},lightShafts:{...DEFAULT_LIGHT_SHAFT_SETTINGS}};
/** Old files containing only sky parameters retain them and receive ocean defaults. */
export function normalizeSceneSettings(value:Partial<SceneSettings>):SceneSettings{
 return {...updateSkySettings({...DEFAULT_SKY_SETTINGS},value),ocean:updateOceanSettings({...DEFAULT_OCEAN_SETTINGS},value.ocean??{}),lightShafts:updateLightShaftSettings({...DEFAULT_LIGHT_SHAFT_SETTINGS},value.lightShafts??{})};
}
