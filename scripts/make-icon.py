"""生成 HF Render 应用图标（PNG + ICO）。"""
from PIL import Image, ImageDraw, ImageFont
import os

SIZE = 1024
BG = (23, 26, 32, 255)          # 近黑深灰
FG = (255, 255, 255, 255)
ACCENT = (77, 141, 255, 255)    # 与界面强调色一致

img = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
draw = ImageDraw.Draw(img)

# 圆角底板
margin = 64
radius = 210
draw.rounded_rectangle(
    [margin, margin, SIZE - margin, SIZE - margin],
    radius=radius,
    fill=BG,
)

# 底部强调色横条（呼应界面的克制点缀）
bar_w = 300
bar_h = 26
bar_x = (SIZE - bar_w) // 2
bar_y = SIZE - margin - 128
draw.rounded_rectangle([bar_x, bar_y, bar_x + bar_w, bar_y + bar_h], radius=13, fill=ACCENT)

# 字母 HF
font = ImageFont.truetype(r"C:\Windows\Fonts\seguisb.ttf", 400)
text = "HF"
bbox = draw.textbbox((0, 0), text, font=font)
tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
pos = ((SIZE - tw) / 2 - bbox[0], (SIZE - th) / 2 - bbox[1] - 62)
draw.text(pos, text, font=font, fill=FG)

out_dir = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "build")
os.makedirs(out_dir, exist_ok=True)

png_path = os.path.join(out_dir, "icon.png")
img.save(png_path, "PNG")

ico_sizes = [(256, 256), (128, 128), (64, 64), (48, 48), (32, 32), (16, 16)]
ico_path = os.path.join(out_dir, "icon.ico")
img.save(ico_path, format="ICO", sizes=ico_sizes)

# 安装包侧边栏图（electron-builder 可选）
print("written:", png_path)
print("written:", ico_path)
