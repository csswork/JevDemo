// Wrap the downloaded CC0 glTF mannequin in VRM 1.0 metadata. Meshes, weights,
// inverse bind matrices and reference transforms remain byte-for-byte unchanged.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const input = process.argv[2];
if (!input) throw new Error('Usage: node motion-workbench/scripts/prepare-mannequin.mjs <source.glb>');
const bytes = fs.readFileSync(input);
if (bytes.readUInt32LE(0) !== 0x46546c67 || bytes.readUInt32LE(4) !== 2) throw new Error('Expected glTF 2.0 binary');
const jsonSize = bytes.readUInt32LE(12);
const model = JSON.parse(bytes.subarray(20, 20 + jsonSize).toString());
const indices = Object.fromEntries(model.nodes.map((n, i) => [n.name, i]));
const boneNames = {
  hips: 'pelvis', spine: 'spine_01', chest: 'spine_02', upperChest: 'spine_03', neck: 'neck_01', head: 'Head',
};
for (const [side, suffix] of [['left', 'l'], ['right', 'r']]) {
  for (const [vrm, source] of Object.entries({ Shoulder: 'clavicle', UpperArm: 'upperarm', LowerArm: 'lowerarm', Hand: 'hand', UpperLeg: 'thigh', LowerLeg: 'calf', Foot: 'foot', Toes: 'ball' })) boneNames[`${side}${vrm}`] = `${source}_${suffix}`;
  for (const [vrm, source] of Object.entries({ Index: 'index', Middle: 'middle', Ring: 'ring', Little: 'pinky' })) {
    for (const [index, segment] of [['01', 'Proximal'], ['02', 'Intermediate'], ['03', 'Distal']]) boneNames[`${side}${vrm}${segment}`] = `${source}_${index}_${suffix}`;
  }
  for (const [index, segment] of [['01', 'Metacarpal'], ['02', 'Proximal'], ['03', 'Distal']]) boneNames[`${side}Thumb${segment}`] = `thumb_${index}_${suffix}`;
}
const humanBones = {};
for (const [name, source] of Object.entries(boneNames)) {
  if (!Number.isInteger(indices[source])) throw new Error(`Missing bone: ${source}`);
  humanBones[name] = { node: indices[source] };
}
model.extensionsUsed = [...new Set([...(model.extensionsUsed ?? []), 'VRMC_vrm'])];
model.extensions = { ...model.extensions, VRMC_vrm: {
  specVersion: '1.0',
  meta: { name: 'Quaternius · Motion Mannequin', version: '1.0', authors: ['Quaternius'], copyrightInformation: 'CC0 1.0 Universal; matte glTF repack from programasweights/avatar', licenseUrl: 'https://creativecommons.org/publicdomain/zero/1.0/', avatarPermission: 'everyone', commercialUsage: 'corporation', creditNotation: 'unnecessary', allowRedistribution: true, modification: 'allowModificationRedistribution', otherLicenseUrl: 'https://quaternius.com/packs/universalbasecharacters.html' },
  humanoid: { humanBones },
} };
const json = Buffer.from(JSON.stringify(model));
const aligned = Buffer.alloc(Math.ceil(json.length / 4) * 4, 0x20); json.copy(aligned);
const binaryChunks = bytes.subarray(20 + jsonSize);
const output = Buffer.alloc(20 + aligned.length + binaryChunks.length);
output.writeUInt32LE(0x46546c67, 0); output.writeUInt32LE(2, 4); output.writeUInt32LE(output.length, 8);
output.writeUInt32LE(aligned.length, 12); output.writeUInt32LE(0x4e4f534a, 16);
aligned.copy(output, 20); binaryChunks.copy(output, 20 + aligned.length);
fs.writeFileSync(path.join(root, 'models/mannequin.vrm'), output);
fs.writeFileSync(path.join(root, 'models/mannequin-source.json'), JSON.stringify({
  author: 'Quaternius', license: 'CC0-1.0', pack: 'https://quaternius.com/packs/universalbasecharacters.html',
  download: 'https://raw.githubusercontent.com/programasweights/avatar/main/public/assets/character.glb',
  provenance: 'https://github.com/programasweights/avatar/blob/main/ASSETS.md', retrievedAt: '2026-10-06',
  sourceSha256: createHash('sha256').update(bytes).digest('hex'), outputSha256: createHash('sha256').update(output).digest('hex'),
  changes: 'Added VRMC_vrm humanoid mapping and CC0 metadata. Preserved geometry, skin weights, inverse bind matrices, reference transforms and the downloaded matte jade material.',
}, null, 2) + '\n');
console.log(`Prepared mannequin.vrm (${output.length} bytes, ${Object.keys(humanBones).length} humanoid bones)`);
