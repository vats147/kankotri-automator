import csv
import os
import time
import re
import requests
from playwright.sync_api import sync_playwright
from datetime import datetime

# Configuration
CSV_FILE = "name.csv"
API_URL = "http://localhost:5001/api/logs"
COUNTRY_CODE = "+91"
OUTPUT_BASE_DIR = os.path.join(os.getcwd(), "server", "output")

def clean_phone_number(phone):
    # Remove non-numeric characters
    digits = re.sub(r'\D', '', str(phone))
    
    if len(digits) < 10:
        return None
    
    # Take last 10 digits
    core_number = digits[-10:]
    
    return f"{COUNTRY_CODE}{core_number}"

def log_status(name, number, status, message=""):
    timestamp = datetime.now().isoformat()
    print(f"[{status}] {name} ({number}): {message}")
    
    # Log to Backend API
    try:
        requests.post(API_URL, json={
            "name": name,
            "number": number,
            "status": status,
            "message": message
        })
    except Exception as e:
        print(f"Failed to log to API: {e}")

def get_safe_filename(name):
    # Match the backend's sanitization logic: replace illegal chars with _
    return re.sub(r'[<>:"/\\|?*]+', '_', name).strip()

def send_whatsapp_messages():
    if not os.path.exists(CSV_FILE):
        print(f"Error: {CSV_FILE} not found.")
        return

    # Ask for Client Name to find the correct folder
    client_name = input("Enter Client Name (folder name in server/output): ").strip()
    client_folder = os.path.join(OUTPUT_BASE_DIR, client_name)
    
    if not os.path.exists(client_folder):
        print(f"Error: Client folder not found at {client_folder}")
        return

    # Read CSV data
    tasks = []
    with open(CSV_FILE, 'r', encoding='utf-8') as f:
        reader = csv.DictReader(f)
        reader.fieldnames = [name.strip() for name in reader.fieldnames]
        
        if 'name' not in reader.fieldnames or 'number' not in reader.fieldnames:
            print("Error: CSV must have 'name' and 'number' columns.")
            return

        for row in reader:
            name = row.get('name')
            raw_number = row.get('number')
            
            if name: name = name.strip()
            if raw_number: raw_number = raw_number.strip()
            else: raw_number = ""
            
            if not name: continue
                
            tasks.append({'name': name, 'raw_number': raw_number})

    if not tasks:
        print("No tasks found in CSV.")
        return

    # Use a local session directory to avoid conflicts with your open Chrome browser.
    # This requires scanning the QR code ONCE, but allows you to keep your main Chrome open.
    user_data_dir = os.path.join(os.getcwd(), "whatsapp_session")
    
    with sync_playwright() as p:
        try:
            # Launch persistent context
            browser = p.chromium.launch_persistent_context(
                user_data_dir,
                channel="chrome", 
                headless=False,
                args=["--start-maximized"],
                no_viewport=True,
                accept_downloads=True
            )
        except Exception as e:
            print(f"Error launching browser: {e}")
            return
        
        page = browser.pages[0]
        
        print("Opening WhatsApp Web...")
        page.goto("https://web.whatsapp.com")
        
        # Wait for login
        try:
            page.wait_for_selector('div[role="textbox"]', timeout=60000)
            print("Login detected!")
        except:
            print("Login not detected. Please log in manually if needed.")
            # We continue anyway in case it's just a slow load, but usually this means not logged in
            # or selector changed.

        for task in tasks:
            name = task['name']
            raw_number = task['raw_number']
            
            # 1. Validate Number
            formatted_number = clean_phone_number(raw_number)
            if not formatted_number:
                log_status(name, raw_number, "FAILED", "Invalid phone number")
                continue
            
            # 2. Check PDF existence
            safe_name = get_safe_filename(name)
            pdf_path = os.path.join(client_folder, f"{safe_name}.pdf")
            
            if not os.path.exists(pdf_path):
                log_status(name, formatted_number, "FAILED", f"PDF not found: {pdf_path}")
                continue
            
            try:
                print(f"Sending to {name} ({formatted_number})...")
                
                # Navigate to chat
                page.goto(f"https://web.whatsapp.com/send?phone={formatted_number[1:]}&text=Here is your invitation")
                
                # Wait for chat to load
                try:
                    page.wait_for_selector('div[role="textbox"][contenteditable="true"]', timeout=30000)
                except:
                    if page.locator("text=Phone number shared via url is invalid").is_visible():
                        log_status(name, formatted_number, "FAILED", "Number not on WhatsApp")
                        continue
                    else:
                        log_status(name, formatted_number, "FAILED", "Chat load timeout")
                        continue

                # 3. Attach PDF
                # Click Attach button (Plus icon)
                attach_btn = page.locator('div[title="Attach"], button[aria-label="Attach"]')
                attach_btn.wait_for(state="visible", timeout=10000)
                attach_btn.click()
                
                # Wait for the menu to appear
                # We use :visible pseudo-class to ensure we don't pick a hidden "Document" span
                document_btn = page.locator('span:has-text("Document"):visible, [aria-label="Document"]:visible').first
                document_btn.wait_for(state="visible", timeout=10000)
                
                # Handle file chooser
                with page.expect_file_chooser() as fc_info:
                    document_btn.click()
                
                file_chooser = fc_info.value
                file_chooser.set_files(pdf_path)
                
                # 4. Send
                # Wait for the file to be attached and processed.
                # The send button might be visible but disabled, or not visible yet.
                # We can also wait for the "Loading..." preview to disappear if possible.
                
                # Wait for Send button to be clickable
                send_btn = page.locator('div[aria-label="Send"]')
                send_btn.wait_for(state="visible", timeout=30000)
                
                # Extra wait to ensure PDF is fully attached (sometimes it takes a second to process)
                time.sleep(3) 
                
                send_btn.click()
                
                # Wait for message to be sent (tick appears)
                # We'll just wait a bit longer to be safe
                time.sleep(5)
                
                log_status(name, formatted_number, "SUCCESS", "Message sent")
                
                # Delay to avoid spam detection
                time.sleep(3)
                
            except Exception as e:
                log_status(name, formatted_number, "ERROR", str(e))
        
        print("All tasks completed.")
        # browser.close()

if __name__ == "__main__":
    send_whatsapp_messages()
