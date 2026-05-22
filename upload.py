import os
import requests

BASE_URL = 'https://cqcpathfinder-staging.up.railway.app/'
MEDIA_DIR = './media'
SESSION_COOKIE = 'ps7809h8thif8z3p2a0ms61jm9fsqc0z'  # grab from browser devtools

session = requests.Session()
session.cookies.set('sessionid', SESSION_COOKIE, domain='cqcpathfinder-staging.up.railway.app')

for root, dirs, files in os.walk(MEDIA_DIR):
    for filename in files:
        local_path = os.path.join(root, filename)
        rel_path = os.path.relpath(local_path, MEDIA_DIR)
        
        print(f'Uploading {rel_path}...', end=' ')
        with open(local_path, 'rb') as f:
            r = session.post(
                f'{BASE_URL}/export_media/upload/',
                files={'file': f},
                data={'path': rel_path}
            )
        print('OK' if r.ok else f'FAILED: {r.text}')