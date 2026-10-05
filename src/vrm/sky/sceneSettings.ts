import {DEFAULT_SKY_SETTINGS,updateSkySettings,type SkySettings} from './skySettings.ts';
import {DEFAULT_OCEAN_SETTINGS,updateOceanSettings,type OceanSettings} from '../ocean/oceanSettings.ts';
export interface SceneSettings extends SkySettings {ocean:OceanSettings;}
export const DEFAULT_SCENE_SETTINGS:SceneSettings={...DEFAULT_SKY_SETTINGS,ocean:{...DEFAULT_OCEAN_SETTINGS}};
/** Old files containing only sky parameters retain them and receive ocean defaults. */
export function normalizeSceneSettings(value:Partial<SceneSettings>):SceneSettings{
 return {...updateSkySettings({...DEFAULT_SKY_SETTINGS},value),ocean:updateOceanSettings({...DEFAULT_OCEAN_SETTINGS},value.ocean??{})};
}
