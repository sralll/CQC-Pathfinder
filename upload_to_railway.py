import os
import requests

TOKEN = 'paste_your_token_here'
BASE_URL = 'https://cqc-pathfinder.ch/bulk-upload/'

def upload_folder(local_folder, remote_folder):
    files = os.listdir(local_folder)
    print(f'\nUploading {len(files)} files to {remote_folder}/')
    for filename in files:
        filepath = os.path.join(local_folder, filename)
        if not os.path.isfile(filepath):
            continue
        with open(filepath, 'rb') as f:
            response = requests.post(
                BASE_URL,
                headers={'X-Upload-Token': TOKEN},
                data={'folder': remote_folder},
                files={'file': (filename, f)},
            )
        if response.status_code == 200:
            print(f'  ✓ {filename}')
        else:
            print(f'  ✗ {filename}: {response.text}')

upload_folder(r'C:\app\media\maps', 'maps')
upload_folder(r'C:\app\media\masks', 'masks')