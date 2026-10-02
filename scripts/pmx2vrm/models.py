"""要转换的模型。pmx 是相对解压目录的路径。"""
from recipes import QUAPPA

QUAPPA_PRESETS = {
    'aa': [('aa', 1)], 'ih': [('ih', 1)], 'ou': [('ou', 1)], 'ee': [('ee', 1)], 'oh': [('oh', 1)],
    'blink': [('blink', 1)], 'blink_left': [('blink_l', 1)], 'blink_right': [('blink_r', 1)],
    # 整脸预设：只在分部位形状没认出来时才用（faceRig.ts 会按语义名直接用上面那些形状）
    'happy': [('eye_smile', 1), ('mouth_smile', 1), ('brow_happy', 1)],
    'angry': [('brow_angry', 1), ('eye_angry', 1), ('mouth_frown', 0.7)],
    'sad': [('brow_sad', 1), ('eye_sad', 1), ('mouth_sad', 1)],
    'relaxed': [('brow_relaxed', 1), ('eye_smile', 0.6), ('mouth_smile', 0.8)],
    'surprised': [('brow_surprised', 1), ('eye_wide', 1), ('mouth_o', 0.6)],
}

QUAPPA_LICENSE = 'https://www.quappael.com/license'


def quappa_meta(name, version):
    return {
        'vrm_name': name,
        'version': version,
        'authors': ['quappael'],
        'copyright_information': '©QUAPPA-ELの巣処',
        'references': ['https://www.quappael.com/'],
        'other_license_url': QUAPPA_LICENSE,
        'third_party_licenses': '配布モデルライセンス規約 ' + QUAPPA_LICENSE + '（PMX から VRM へ変換、既定で非表示の部品は削除）',
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


MODELS = {
    'himekawa': dict(
        pmx='EL-Pr231(HIMEKAWA)/姫川 茶菰.pmx',
        meta=quappa_meta('姫川 茶菰', '0.0.7'),
        # 默认可见但属于恶搞部件（口パンツ 变形才露出来）
        hide_materials=['[UWEAR]MouthPants'],
        recipes=QUAPPA,
        presets=QUAPPA_PRESETS,
        # 膝捩 由付与驱动、挂在腰キャンセル 下面，运行时不会跟着大腿转 → 并回大腿
        merge_weights={'膝捩.L': '足.L', '膝捩.R': '足.R'},
        # 錘 是 MMD 物理的配重骨；胸 / 尻 的物理不做（对话场景里只会添乱）
        spring_skip=('錘', '胸', '尻'),
        springs={
            'おさげ': dict(stiffness=0.9, drag=0.35, gravity=0.1),
            '*': dict(stiffness=1.6, drag=0.5, gravity=0.05, max_radius=0.02),
        },
        material=dict(blend_materials=('[HAIR]Alpha',)),
    ),
}
