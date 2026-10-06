# 动作工作台

独立的 HY-Motion 1.0 本地工具。复用项目依赖，但有单独的页面、开发服务与素材目录，不加载项目聊天、场景或正式动作配置。

```sh
npm run motion
```

打开 http://127.0.0.1:5680 。项目原本的 `npm run dev` 不受影响。

## 操作

1. 点击动作库的 **＋**，填写名称、动作描述和时长。也可以直接导入 FBX。
   尚未选择动作时可以点击 **载入免费演示动作**，用随工具提供的自制骨架练习编辑与导出，不调用腾讯云。
2. **生成新版本** 会保存当前描述，并调用 HY-Motion 1.0。每次点击生成会消耗腾讯云积分；工作台不会自动重试提交。只允许一个生成任务同时进行。
3. 从版本记录中选择候选，播放、拖动时间轴，调整起止时间、速度、水平位移、地面基准和骨骼角度。
4. **保存为新版本** 留下新的编辑记录，旧版本与原始 FBX 保留。切回旧版本可重新分支迭代。
5. 默认使用有蒙皮的素体预览。可切换 **夏夏 · 项目角色**、原始动作、示例 VRM，或载入本地 `.vrm` 替换角色；切换时保留同一时间点。镜头自动适配全身，骨架叠层默认关闭，可按需打开。骨骼角度为局部轴；VRM 为规范化骨骼轴，因此两个视图的轴向效果可能不同。这里延续项目旧的 SMPL-H 重定向方法，没有 IK 或碰撞求解。
6. 满意后标记当前版本成熟。新生成或新保存调整会重置成熟标记，确保新候选重新检查。切回 **原始动作**，保存修改，导出烘焙后的 **GLB**、**编辑记录 JSON**，或下载原始 **FBX**。工具不写入正式项目的动作配置；GLB 是通用骨骼动画，接入 VRM 时仍需重定向。
7. 删除动作会将所有版本移到回收站，点击回收站中的动作可恢复。生成中不能删除。

## AI 补充描述

填写简短动作意图后，点击描述旁的 **✦ AI 补充**，使用项目 `.env.local` 中的 `DEEPSEEK_API_KEY` 调用 DeepSeek。可选 `DEEPSEEK_BASE_URL` / `DEEPSEEK_MODEL`，默认 `https://api.deepseek.com` / `deepseek-flash`。

AI 根据当前描述、时长与已有细节，补充重心、肩肘腕、手掌方向、腿脚触地、动作节奏和收势，并给出起始、过渡、峰值与结束等关键姿态及秒数。结果包含：

- **生成描述**：不超过 128 字，发给 HY-Motion。
- **动作细节与关键姿态**：完整的时间节点与姿态描述，保留作为迭代参考，可继续编辑；随动作保存，并在新生成/导入版本里留档。

补充结果先放入可编辑草稿，不自动保存或生成动作。**撤销 AI 补充** 能还原调用前的描述与细节。HY-Motion 的文生动作接口只接受生成描述，关键姿态参考不会变成逐帧硬约束。每次点击 AI 补充产生 DeepSeek API 用量；不自动重试或调用动作生成。

## 预览模型

- **素体**：Quaternius 的 Universal Base Characters（Superhero Male，CC0 1.0）。下载已打包的无贴图、哑光 glTF，将骨骼映射为工具内部的 VRM 人形格式；几何、蒙皮权重和绑定矩阵保留。模型位于 `motion-workbench/models/mannequin.vrm`，授权文本与来源/SHA-256 收据保存在同目录。
- **夏夏**：直接读取正式项目已有的 `public/models/AvatarSample_A.vrm`，不复制或修改模型。

素体来源：[作者与授权说明](https://quaternius.com/packs/universalbasecharacters.html)、[下载文件的来源记录](https://github.com/programasweights/avatar/blob/main/ASSETS.md)。素体保留 CC0 元数据，加载器仅额外接受这个明确的授权 URL。要重新包装已下载的原始 GLB：

```sh
node motion-workbench/scripts/prepare-mannequin.mjs /absolute/path/to/character.glb
```

## 数据与密钥

- 密钥读取项目根目录 `.env.local` 的 `TENCENTCLOUD_SECRET_ID` / `TENCENTCLOUD_SECRET_KEY`，可选 `TENCENTCLOUD_REGION`。只在服务端使用，不返回浏览器。
- 本地动作库：`data/motion-workbench/library.json`。
- 不变的原始素材：`data/motion-workbench/assets/<版本 ID>.fbx`。
- 数据沿用项目 `data/` 的 Git 忽略规则。备份时复制整个 `data/motion-workbench/`。
- 关闭工具后，任务编号仍保留；下次启动继续查询。查询或下载失败的版本可点击 **重新查询结果**，不会重新生成。提交阶段被中断且没拿到任务编号时，先在腾讯云核查，避免重复收费。
- 服务仅监听本机 `127.0.0.1:5680`，拒绝跨站调用。没有生产托管接口；请使用 `npm run motion` 运行。

## 导出语义

GLB 以 30fps 采样并烘焙裁剪、播放速度、骨骼偏移和根位移校正，保留源蒙皮（源 FBX 若有）。源单位按照 HY-Motion 的厘米转换为米。水平锁定以裁剪后第一帧胯部为基准；地面校正以裁剪段采样中的最低脚关节为基准。循环是播放器/编辑记录设置，不承诺自动生成无缝首尾。

任意 FBX 可导入，但姿态编辑和 VRM 预览针对 HY-Motion 的 SMPL-H 命名。其他骨架可预览，骨骼偏移和单位可能需要额外适配。

```sh
npm run motion:check
```

测试覆盖版本隔离、重启持久化、回收站恢复、输入与路径校验、剪辑边界/速度烘焙、GLB 导出后重新加载、素体蒙皮随动作变形、AI 结构化结果/时间校验，以及模拟云端任务的并发限制、恢复查询和下载。测试不会调用真实生成接口。

接口参考：[腾讯云提交文生动作任务](https://cloud.tencent.com/document/product/1804/131256)、[DeepSeek JSON 输出](https://api-docs.deepseek.com/guides/json_mode/)。
