import os
import requests

TOKEN = '40f0c49fefefeb1bdb85f6429e4658a7ec8aa59f91e89691065ac247bb033a1f'
BASE_URL = 'https://cqc-pathfinder.ch/bulk-upload/'
CHUNK_SIZE = 2 * 1024 * 1024  # 2MB

def upload_file(filepath, remote_folder):
    filename = os.path.basename(filepath)
    file_size = os.path.getsize(filepath)

    with open(filepath, 'rb') as f:
        data = f.read()

    response = requests.post(
        BASE_URL,
        headers={'X-Upload-Token': TOKEN},
        data={'folder': remote_folder},
        files={'file': (filename, data)},
        timeout=120,
    )
    return response.status_code == 200, response.text

def upload_folder(local_folder, remote_folder):
    files = sorted(os.listdir(local_folder))
    print(f'\nUploading {len(files)} files to {remote_folder}/')
    for filename in files:
        filepath = os.path.join(local_folder, filename)
        if not os.path.isfile(filepath):
            continue
        size = os.path.getsize(filepath)
        print(f'  {filename} ({size/1024/1024:.1f}MB)...', end=' ')
        success, text = upload_file(filepath, remote_folder)
        print('✓' if success else f'✗ {text[:100]}')

upload_folder(r'C:\app\media\maps', 'maps')
upload_folder(r'C:\app\media\masks', 'masks')