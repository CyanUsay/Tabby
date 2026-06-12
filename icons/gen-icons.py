# 生成 Tabby 图标：由用户提供的源图 source-icon.png（带透明边的 squircle，
# navy 底 + 灰虎斑猫 + 月亮+爱心）派生各尺寸。
# 用法：python3 icons/gen-icons.py（在仓库根目录执行）
from PIL import Image

NAVY = (24, 22, 35)  # squircle 底色（采样自源图边缘）
src = Image.open('icons/source-icon.png').convert('RGBA')

def flatten(size):
    # 透明角填 navy → 满幅方图，iOS/桌面自行倒角
    bg = Image.new('RGBA', src.size, NAVY + (255,))
    bg.alpha_composite(src)
    return bg.convert('RGB').resize((size, size), Image.LANCZOS)

for size, name in [(180, 'icon-180.png'), (192, 'icon-192.png'), (512, 'icon-512.png')]:
    flatten(size).save(f'icons/{name}')

# maskable：内容缩到 80% 安全区，navy 满底（Android 圆形遮罩用）
mask = Image.new('RGBA', (512, 512), NAVY + (255,))
inner = src.resize((410, 410), Image.LANCZOS)
mask.alpha_composite(inner, (51, 51))
mask.convert('RGB').save('icons/icon-maskable-512.png')
print('icons generated from source-icon.png')
