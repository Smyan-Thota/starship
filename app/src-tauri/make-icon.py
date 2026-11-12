"""Draws the app icon and the menu bar icon. Run: python3 make-icon.py (needs Pillow).
Then: bun run --cwd app tauri icon src-tauri/icons/source.png"""
from PIL import Image, ImageDraw

def ship(size, fg, bg):
    img = Image.new("RGBA", (size, size), bg)
    d = ImageDraw.Draw(img)
    s = size / 1024
    d.polygon([(512 * s, 150 * s), (800 * s, 830 * s), (512 * s, 680 * s), (224 * s, 830 * s)], fill=fg)
    return img

ship(1024, (235, 235, 235, 255), (25, 25, 25, 255)).save("icons/source.png")
ship(44, (0, 0, 0, 255), (0, 0, 0, 0)).save("icons/tray.png")
