# 生成 Tabby 图标：莫兰迪蓝底 + 简笔虎斑猫脸（带耳朵条纹）。
# 用法：python3 icons/gen-icons.py（在仓库根目录执行）
from PIL import Image, ImageDraw

BG = (227, 232, 238)        # 雾蓝灰底（日间主题底色）
FACE = (143, 168, 191)      # 灰蓝猫脸
STRIPE = (108, 138, 166)    # 深一档的条纹
EAR_IN = (232, 180, 188)    # 粉色内耳
EYE = (58, 74, 90)          # 深灰蓝
NOSE = (217, 154, 166)      # 粉鼻子

S = 1024

def draw_cat(pad_ratio=0.0):
    img = Image.new('RGB', (S, S), BG)
    d = ImageDraw.Draw(img)
    # pad_ratio>0 时整体缩小（maskable 安全区）
    scale = 1 - pad_ratio * 2
    def p(x, y):
        return (S * (pad_ratio + x * scale), S * (pad_ratio + y * scale))

    # 耳朵（三角）
    d.polygon([p(.18, .42), p(.22, .12), p(.46, .30)], fill=FACE)
    d.polygon([p(.82, .42), p(.78, .12), p(.54, .30)], fill=FACE)
    d.polygon([p(.235, .36), p(.255, .19), p(.40, .305)], fill=EAR_IN)
    d.polygon([p(.765, .36), p(.745, .19), p(.60, .305)], fill=EAR_IN)
    # 脸（椭圆）
    d.ellipse([p(.13, .25), p(.87, .88)], fill=FACE)
    # 额头虎斑条纹
    for cx in (.40, .50, .60):
        d.polygon([p(cx - .022, .26), p(cx + .022, .26), p(cx + .010, .40), p(cx - .010, .40)], fill=STRIPE)
    # 眼睛
    r = .035
    for cx in (.36, .64):
        d.ellipse([p(cx - r, .54 - r), p(cx + r, .54 + r)], fill=EYE)
    # 鼻子 + 嘴
    d.polygon([p(.47, .645), p(.53, .645), p(.50, .685)], fill=NOSE)
    w = int(S * .012 * scale)
    d.arc([*p(.43, .66), *p(.50, .745)], 20, 160, fill=EYE, width=w)
    d.arc([*p(.50, .66), *p(.57, .745)], 20, 160, fill=EYE, width=w)
    # 胡须
    for y in (.62, .67):
        d.line([*p(.14, y), *p(.27, y + .015)], fill=STRIPE, width=w)
        d.line([*p(.86, y), *p(.73, y + .015)], fill=STRIPE, width=w)
    return img

base = draw_cat()
for size, name in [(180, 'icon-180.png'), (192, 'icon-192.png'), (512, 'icon-512.png')]:
    base.resize((size, size), Image.LANCZOS).save(f'icons/{name}')
draw_cat(pad_ratio=0.10).resize((512, 512), Image.LANCZOS).save('icons/icon-maskable-512.png')
print('icons generated')
