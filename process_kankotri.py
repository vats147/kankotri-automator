import csv
import os
import urllib.request
from reportlab.pdfgen import canvas
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.lib.colors import red
from pypdf import PdfReader, PdfWriter
from playwright.sync_api import sync_playwright
from PIL import Image

# Configuration
FONT_URL = "https://github.com/googlefonts/noto-fonts/raw/main/hinted/ttf/NotoSansGujarati/NotoSansGujarati-Bold.ttf"
FONT_FILENAME = "NotoSansGujarati-Bold.ttf"
INPUT_PDF = "kankotri.pdf"
CSV_FILE = "name.csv"
X_COORD = 208
Y_COORD = 385
FONT_SIZE = 14
TEXT_COLOR = 'red'

def download_font():
    if not os.path.exists(FONT_FILENAME):
        print(f"Downloading font from {FONT_URL}...")
        try:
            os.system(f"curl -L -o {FONT_FILENAME} {FONT_URL}")
            print("Font downloaded.")
        except Exception as e:
            print(f"Error downloading font: {e}")
            exit(1)

def create_text_image_playwright(text, font_path, font_size, color):
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page()
        
        # Absolute path for font file to ensure browser can load it
        abs_font_path = os.path.abspath(font_path)
        
        # Create HTML with embedded font
        html_content = f"""
        <html>
        <head>
            <style>
                @font-face {{
                    font-family: 'GujaratiFont';
                    src: url('file://{abs_font_path}') format('truetype');
                }}
                body {{
                    margin: 0;
                    padding: 0;
                    background: transparent;
                }}
                .text {{
                    font-family: 'GujaratiFont', sans-serif;
                    font-size: {font_size * 4}px; /* High res for quality */
                    color: {color};
                    font-weight: bold;
                    display: inline-block;
                    white-space: nowrap;
                    padding: 5px; /* Padding to avoid clipping */
                }}
            </style>
        </head>
        <body>
            <div id="content" class="text">{text}</div>
        </body>
        </html>
        """
        
        page.set_content(html_content)
        
        # Get bounding box
        locator = page.locator('#content')
        
        # Take screenshot of the element
        screenshot_bytes = locator.screenshot(type='png', omit_background=True)
        
        browser.close()
        
        # Save to temp file
        temp_img = f"temp_pw_{text}.png"
        with open(temp_img, "wb") as f:
            f.write(screenshot_bytes)
            
        return temp_img

def create_overlay(text, output_path):
    c = canvas.Canvas(output_path)
    
    # Generate text image using Playwright
    try:
        img_path = create_text_image_playwright(text, FONT_FILENAME, FONT_SIZE, TEXT_COLOR)
        
        if img_path and os.path.exists(img_path):
            img = Image.open(img_path)
            pix_w, pix_h = img.size
            
            # Scale back down. We rendered at 4x font size.
            # But we also need to convert pixels to points.
            # Browser 1px ~ 1/96 inch? Or just relative.
            # We set font-size: {font_size * 4}px.
            # We want it to be {font_size} points on PDF.
            # 1 point = 1/72 inch.
            # If we assume browser px is roughly equivalent to points for sizing logic (it's not exactly, but close enough for web-to-print often),
            # we rendered at 4x. So we scale by 0.25.
            # Let's refine:
            # We want final height on PDF to be roughly FONT_SIZE points.
            # The image height includes some padding.
            # Let's just scale by 0.25 (since we multiplied by 4).
            
            scale = 0.25
            pdf_w = pix_w * scale
            pdf_h = pix_h * scale
            
            # Draw image
            # Y_COORD is where we want the text baseline roughly.
            # Image includes padding.
            # Let's center it vertically on Y_COORD or just place it.
            # User provided specific coordinates, likely for baseline or top-left.
            # Let's assume baseline-ish.
            c.drawImage(img_path, X_COORD, Y_COORD, width=pdf_w, height=pdf_h, mask='auto')
            
            os.remove(img_path)
        else:
            print("Failed to generate image with Playwright")
    except Exception as e:
        print(f"Error in Playwright rendering: {e}")
            
    c.save()

def process_pdfs():
    if not os.path.exists(INPUT_PDF):
        print(f"Error: {INPUT_PDF} not found.")
        return

    if not os.path.exists(CSV_FILE):
        print(f"Error: {CSV_FILE} not found.")
        return

    with open(CSV_FILE, 'r', encoding='utf-8') as f:
        reader = csv.DictReader(f)
        
        if 'name' not in reader.fieldnames:
            print("Error: CSV must have a 'name' column.")
            return

        for row in reader:
            name = row['name']
            if not name:
                continue
            
            print(f"Processing: {name}")
            
            overlay_filename = f"temp_{name}.pdf"
            output_filename = f"{name}.pdf"
            
            try:
                create_overlay(name, overlay_filename)
                
                reader_base = PdfReader(INPUT_PDF)
                reader_overlay = PdfReader(overlay_filename)
                writer = PdfWriter()
                
                page = reader_base.pages[0]
                if len(reader_overlay.pages) > 0:
                    page.merge_page(reader_overlay.pages[0])
                
                writer.add_page(page)
                
                for i in range(1, len(reader_base.pages)):
                    writer.add_page(reader_base.pages[i])
                
                with open(output_filename, "wb") as out_f:
                    writer.write(out_f)
                
                print(f"Saved: {output_filename}")
                
            except Exception as e:
                print(f"Error processing {name}: {e}")
            finally:
                if os.path.exists(overlay_filename):
                    os.remove(overlay_filename)

if __name__ == "__main__":
    download_font()
    process_pdfs()
