# 场景素材

咖啡店场景本身是程序生成的（src/vrm/scenes/cafe.ts），这里只有它打光用的 HDRI；
公园（src/vrm/scenes/park.ts）用全景背景 + 真实模型；
街景（src/vrm/scenes/street.ts）除了借用公园的路灯、木板材质、打光的 HDR，咖啡店的几盆绿植，全部程序生成，没有自己的素材文件。

全部来自 [Poly Haven](https://polyhaven.com)，**CC0**（公有领域，可商用、可再分发、不要求署名）。
由 `scripts/fetch-scene-assets.mjs` 下载（1k 分辨率）。署名不是必须的，这里列出作者以示感谢：

- 模型 [Street Lamp 01](https://polyhaven.com/a/street_lamp_01) — Josh Dean
- 模型 [Rock Moss Set 01](https://polyhaven.com/a/rock_moss_set_01) — Kless Gyzen
- 材质 [Weathered Brown Planks](https://polyhaven.com/a/weathered_brown_planks) — Dimitrios Savva, Rico Cilliers
- 材质 [Aerial Grass Rock](https://polyhaven.com/a/aerial_grass_rock) — Rob Tuytel
- 材质 [Plastered Wall 02](https://polyhaven.com/a/plastered_wall_02) — Charlotte Baglioni
- 材质 [Asphalt 02](https://polyhaven.com/a/asphalt_02) — Rob Tuytel
- 材质 [Square Tiles 03](https://polyhaven.com/a/square_tiles_03) — Charlotte Baglioni
- 材质 [Concrete Wall 008](https://polyhaven.com/a/concrete_wall_008) — Dario Barresi, Charlotte Baglioni
- 材质 [Ceramic Roof 01](https://polyhaven.com/a/ceramic_roof_01) — Rob Tuytel
- HDRI [Wooden Lounge](https://polyhaven.com/a/wooden_lounge) — Greg Zaal
- HDRI [Nagoya Wall Path](https://polyhaven.com/a/nagoya_wall_path) — Greg Zaal
- HDRI [Furry Clouds](https://polyhaven.com/a/furry_clouds) — Greg Zaal, Rico Cilliers

公园的树和灌木由 [ez-tree](https://github.com/dgreenheck/ez-tree)（npm `@dgreenheck/ez-tree`，© 2024 Daniel Greenheck，**MIT**）生成，树皮和树叶贴图打包在那个 npm 包里；`eztree/grass.glb`（草丛模型）来自 ez-tree 的演示场景，授权原文见 `eztree/LICENSE`。

## 咖啡店的小物件（`polypizza/`）

来自 [Poly Pizza](https://poly.pizza)。CC0 的不要求署名；CC-BY（[Creative Commons Attribution 3.0](https://creativecommons.org/licenses/by/3.0/)）的必须署名，就是下面这样：

- [Coffee Machine](https://poly.pizza/m/kRpKjpQsEd) — Zsky，CC-BY 3.0
- [Cup Tea](https://poly.pizza/m/M2sVC8jbmi) — Kenney，CC0
- [Cup](https://poly.pizza/m/aSF8ANEIsX) — Kenney，CC0
- [Frappe](https://poly.pizza/m/ZvYPiZeN0V) — Kenney，CC0
- [Cake](https://poly.pizza/m/KGFyP16ebH) — Kenney，CC0
- [Cupcake](https://poly.pizza/m/txZDsDca1L) — Kenney，CC0
- [Muffin](https://poly.pizza/m/YZWplO0tzB) — Kenney，CC0
- [Donut Sprinkles](https://poly.pizza/m/RnPNAFyKtY) — Kenney，CC0
- [Croissant](https://poly.pizza/m/JDy2TUxcV2) — Kenney，CC0
- [Bar Stool](https://poly.pizza/m/2do92chR2k) — Kenney，CC0
- [Round Table](https://poly.pizza/m/AXbvcMDC8j) — Kenney，CC0
- [Chair](https://poly.pizza/m/vHyrBYPBum) — Kenney，CC0
- [Light Ceiling](https://poly.pizza/m/S3HkX8iTl2) — Quaternius，CC0
- [Houseplant](https://poly.pizza/m/bfLOqIV5uP) — Quaternius，CC0
- [Houseplant](https://poly.pizza/m/Kr4kr7OCCQ) — Quaternius，CC0
- [Houseplant](https://poly.pizza/m/VtJh4Irl4w) — Quaternius，CC0
- [Rug Round](https://poly.pizza/m/jeDDiN69Ze) — Kenney，CC0
- [Lamp Round Table](https://poly.pizza/m/auXnXwXD7S) — Kenney，CC0
- [Wood Floor](https://poly.pizza/m/Jw4zM0TcVo) — Quaternius，CC0
- [Door Double](https://poly.pizza/m/blrNJIEdns) — Quaternius，CC0
- [Window Large](https://poly.pizza/m/EipzkrS9nG) — Quaternius，CC0
- [Window Small](https://poly.pizza/m/n88WAcjzTv) — Quaternius，CC0
- [Couch Medium](https://poly.pizza/m/mWgQ94zhDZ) — Quaternius，CC0
- [Lounge Chair](https://poly.pizza/m/RY93lbAIFg) — Kenney，CC0
- [Coffee Table](https://poly.pizza/m/y4ZU5S7RuD) — Kenney，CC0
- [Bookcase with Books](https://poly.pizza/m/tACDGJ4CGW) — Quaternius，CC0
- [Coat Rack Standing](https://poly.pizza/m/8jXUm32dKW) — Kenney，CC0
- [Book](https://poly.pizza/m/h3Wh4fxSQX) — Quaternius，CC0
- [Wall painting](https://poly.pizza/m/62zn39CRkbG) — jeremy，CC-BY 3.0
- [Wall painting](https://poly.pizza/m/0CiZ4f1cZaF) — jeremy，CC-BY 3.0
- [Analog clock](https://poly.pizza/m/5gAoMR2YHs3) — Poly by Google，CC-BY 3.0
- [Vase](https://poly.pizza/m/7img3RnfCzZ) — Poly by Google，CC-BY 3.0

## 场景背景音（`public/audio/`）

每个场景一条循环环境音（咖啡店人声 / 公园鸟鸣），**CC0**（公有领域，可商用、可再分发、不要求署名）。
播放见 `src/speech/ambience.ts`：整段解码成 AudioBuffer 之后按缓冲区循环 —— 浏览器在**样本级**绕回开头。

> **素材必须是 OGG（Opus/Vorbis），不能用 MP3。** MP3 编码器的补零会在每圈接缝处留一小段静音，
> 循环时"咔"一下。换素材时注意这一点。

- 咖啡店 [coffee shop ambience](https://freesound.org/people/waweee/sounds/370973/) — waweee，CC0（4:56）
- 公园 [Spring Birds & Woodpeckers (Loop)](https://freesound.org/people/Resaural/sounds/634511/) — Resaural，CC0（7:11，作者录的就是无缝循环）
