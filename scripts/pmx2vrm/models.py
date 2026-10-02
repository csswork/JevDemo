"""要转换的模型。pmx 是相对解压目录（压缩包解开后的顶层目录）的路径。

QUAPPA-EL 的模型共用一套骨骼 / 材质 / 物理的命名规范，所以下面几张表是共用的，
单个模型只写和别人不一样的地方。"""

# 整脸预设：只在分部位形状没认出来时才用（faceRig.ts 会按语义名直接用 recipes.py 烘出来的形状）
PRESETS = {
    'aa': [('aa', 1)], 'ih': [('ih', 1)], 'ou': [('ou', 1)], 'ee': [('ee', 1)], 'oh': [('oh', 1)],
    'blink': [('blink', 1)], 'blink_left': [('blink_l', 1)], 'blink_right': [('blink_r', 1)],
    'happy': [('eye_smile', 1), ('mouth_smile', 1), ('brow_happy', 1)],
    'angry': [('brow_angry', 1), ('eye_angry', 1), ('mouth_frown', 0.7)],
    'sad': [('brow_sad', 1), ('eye_sad', 1), ('mouth_sad', 1)],
    'relaxed': [('brow_relaxed', 1), ('eye_smile', 0.6), ('mouth_smile', 0.8)],
    'surprised': [('brow_surprised', 1), ('eye_wide', 1), ('mouth_o', 0.6)],
}

# 默认 alpha 0 的材质（换装差分、R18 部件…）总是删。这些是默认可见、但也要删的（材质名子串）：
#   [EFFECT] / Cartoon：眼泪、漫符，平时藏在头里靠变形弹出来
#   MouthPants：口パンツ 恶搞部件（藏在嘴里）
#   [BODY]Adult：R18 部件（被衣服盖着，看不见，但不该带上）
HIDE_MATERIALS = ('[EFFECT]', 'Cartoon', 'MouthPants', '[BODY]Adult')

# 不做成弹簧骨的物理：胸 / 臀（对话场景里只会添乱）、錘（MMD 物理的配重骨）、
# 自動袖上がり / レッグバンド / 胸移動物理（辅助物理，没有 MMD 的关节约束就会乱飘）
SPRING_SKIP = {
    'exact': ('胸', '尻', '胸先', '尻先'),
    'contains': ('錘', '自動袖', 'レッグバンド', '胸移動'),
}

HAIR = ('髪', 'もみあげ', 'おさげ', 'ﾂｲﾝﾃ', 'ツインテ', 'ロング', '三つ編み', '無雑作', 'ハネ毛')
SKIRT = ('スカート', 'ｽｶｰﾄ', '裾')

# 按链根名字匹配（从上往下第一个匹配的）。长度 = 关节数（不含补的尾骨）
SPRINGS = {
    'hair_long': dict(match=HAIR, min_len=3, stiffness=0.9, drag=0.35, gravity=0.1),
    'hair': dict(match=HAIR, stiffness=1.6, drag=0.5, gravity=0.05, max_radius=0.02),
    # 裙摆：没有 MMD 那种横向关节兜着，刚度 / 阻尼要高一些，命中半径要小（只撞腿，见 convert.leg_colliders）
    'skirt': dict(match=SKIRT, stiffness=2.0, drag=0.65, gravity=0.05, max_radius=0.04, soften=0.25),
    '*': dict(stiffness=1.2, drag=0.5, gravity=0.1, max_radius=0.03),
}

QUAPPA_LICENSE = 'https://www.quappael.com/license'


def quappa_meta(name, version, extra_authors=(), note=''):
    return {
        'vrm_name': name,
        'version': version,
        'authors': ['quappael', *extra_authors],
        'copyright_information': '©QUAPPA-ELの巣処',
        'references': ['https://www.quappael.com/'],
        'other_license_url': QUAPPA_LICENSE,
        'third_party_licenses': f'配布モデルライセンス規約 {QUAPPA_LICENSE}（PMX から VRM へ変換、既定で非表示の部品は削除）{note}',
        'avatar_permission': 'onlyAuthor',
        'commercial_usage': 'personalNonProfit',
        'credit_notation': 'required',
        'modification': 'allowModification',
        'allow_redistribution': False,
        'allow_excessively_violent_usage': False,
        'allow_excessively_sexual_usage': False,
        'allow_political_or_religious_usage': False,
        'allow_antisocial_or_hate_usage': False,
    }


def quappa(pmx, name, version, **kw):
    return dict(pmx=pmx, meta=quappa_meta(name, version, kw.pop('extra_authors', ()), kw.pop('note', '')),
                springs=SPRINGS, material=dict(blend_materials=('[HAIR]Alpha',)), **kw)


# id → 配置。输出文件名 = 产品编号（见 src/models.ts）
MODELS = {
    'himekawa': quappa('EL-Pr231(HIMEKAWA)/姫川 茶菰.pmx', '姫川 茶菰', '0.0.7'),
    'quelle': quappa('EL-F3U-Quelle(Edit by SirAyane)/クウェレ(Edit).pmx', 'クウェレ', 'D.TBP.1.0-RE_140621',
                     extra_authors=('SirAyane',), note='（Edit by SirAyane）'),
    'menabell': quappa('EL-Pr236(Menabell)/メナベル.pmx', 'メナベル・シーウィンド', '1.0.2'),
    'kuromatsu': quappa('EL-Pr238(KUROMATSU)/黒松 沙瑠紗.pmx', '黒松 沙瑠紗', '1.1.1'),
    'kananagi': quappa('EL-Pr242(KANANAGI)/奏渚 汐藍.pmx', '奏渚 汐藍', '1.0.4'),
    'fukuharae': quappa('EL-Pr243M1(FUKUHARAE)/伏祓 七々春(カジュアルパンク).pmx', '伏祓 七々春', '1.0.1'),
    'inahade': quappa('EL-Pr250(INAHADE)/稲葉出ルエカ.pmx', '稲葉出ルエカ', '1.0.3'),
    'rosastout': quappa('EL-Pr251(Rosastout)/ローザスタウト.pmx', 'ローザスタウト', '1.1.2'),
    'kotora': quappa('EL-Pr252(KOTORA)/小寅 百合ヰ.pmx', '小寅 百合ヰ', '1.2.3'),
    'kotora_gym': quappa('EL-Pr252(KOTORA)/小寅 百合ヰ(体操服).pmx', '小寅 百合ヰ（体操服）', '1.2.3'),
}
