"""يولّد وسائط اختبار صغيرة للإعلانات (صور + فيديو MP4)."""
import os, subprocess
from PIL import Image, ImageDraw

def make_image(path, color, label, size=(1280, 720)):
    im = Image.new('RGB', size, color)
    d = ImageDraw.Draw(im)
    d.rectangle([40, 40, size[0] - 40, size[1] - 40], outline=(255, 255, 255), width=12)
    d.text((size[0] // 2 - 100, size[1] // 2 - 10), label, fill=(255, 255, 255))
    ext = path.rsplit('.', 1)[1].lower()
    im.save(path, {'jpg': 'JPEG', 'png': 'PNG', 'webp': 'WEBP'}[ext])

def make_video(path, seconds=2, codec='libx264'):
    args = ['ffmpeg', '-y', '-loglevel', 'error', '-f', 'lavfi', '-i', f'testsrc=duration={seconds}:size=640x360:rate=15',
            '-c:v', codec, '-pix_fmt', 'yuv420p', '-an']
    if codec == 'libx264': args += ['-movflags', '+faststart']
    if codec == 'libvpx-vp9': args += ['-b:v', '200k']
    subprocess.run(args + [path], check=True)

def make_all(d):
    os.makedirs(d, exist_ok=True)
    make_image(f'{d}/hi.jpg', (180, 40, 40), 'JPG HIGH PRIORITY')
    make_image(f'{d}/mid.png', (30, 120, 60), 'PNG')
    make_image(f'{d}/low.webp', (40, 60, 160), 'WEBP')
    try: make_video(f'{d}/clip.mp4', 2, 'libx264'); codec = 'h264'
    except Exception: make_video(f'{d}/clip.mp4', 2, 'libvpx-vp9'); codec = 'vp9'
    return codec
