# 生成 Tabby 图标：由用户提供的源图 source-icon.png 派生各尺寸。
# 源图是带透明边的 squircle；这里裁掉透明边、navy 底填满到四边
# （深蓝紫背景框贴合边缘，内容随之放大），iOS/桌面自行倒角。
# 用法：python3 icons/gen-icons.py（在仓库根目录执行）
from PIL import Image

NAVY = (24, 22, 35)  # squircle 底色（采样自源图边缘）
src = Image.open('icons/source-icon.png').convert('RGBA')

# 裁掉四周透明边，让内容贴合方框
bbox = src.getchannel('A').point(lambda a: 255 if a > 20 else 0).getbbox()
trimmed = src.crop(bbox)

def flatten(content, size, pad=0):
    side = max(content.size)
    canvas = Image.new('RGBA', (side, side), NAVY + (255,))
    inner = content
    if pad:  # 缩进留安全区（maskable 用）
        s = int(side * (1 - pad * 2))
        inner = content.resize((s, s), Image.LANCZOS)
    off = ((side - inner.size[0]) // 2, (side - inner.size[1]) // 2)
    canvas.alpha_composite(inner, off)
    return canvas.convert('RGB').resize((size, size), Image.LANCZOS)

for size, name in [(180, 'icon-180.png'), (192, 'icon-192.png'), (512, 'icon-512.png')]:
    flatten(trimmed, size).save(f'icons/{name}')

# maskable：navy 满底（贴四边）+ 内容留 12% 安全区（Android 圆形遮罩）
flatten(trimmed, 512, pad=0.12).save('icons/icon-maskable-512.png')
print('icons generated from source-icon.png (trimmed to edges)')
