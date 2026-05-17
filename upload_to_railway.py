import os
import requests
import math

TOKEN = '40f0c49fefefeb1bdb85f6429e4658a7ec8aa59f91e89691065ac247bb033a1f'
BASE_URL = 'https://cqc-pathfinder.ch/bulk-upload/'
CHUNK_SIZE = 5 * 1024 * 1024  # 5MB chunks

def upload_file(filepath, remote_folder):
    filename = os.path.basename(filepath)
    file_size = os.path.getsize(filepath)
    total_chunks = math.ceil(file_size / CHUNK_SIZE)

    with open(filepath, 'rb') as f:
        for chunk_index in range(total_chunks):
            chunk_data = f.read(CHUNK_SIZE)
            response = requests.post(
                BASE_URL,
                headers={'X-Upload-Token': TOKEN},
                data={
                    'folder': remote_folder,
                    'filename': filename,
                    'chunk_index': chunk_index,
                    'total_chunks': total_chunks,
                },
                files={'file': (filename, chunk_data)},
            )
            if response.status_code != 200:
                print(f'  ✗ {filename} chunk {chunk_index}: {response.text}')
                return False
            print(f'  chunk {chunk_index + 1}/{total_chunks} ok')

    return True

def upload_folder(local_folder, remote_folder):
    files = os.listdir(local_folder)
    print(f'\nUploading {len(files)} files to {remote_folder}/')
    for filename in sorted(files):
        filepath = os.path.join(local_folder, filename)
        if not os.path.isfile(filepath):
            continue
        print(f'  Uploading {filename}...')
        success = upload_file(filepath, remote_folder)
        if success:
            print(f'  ✓ {filename}')

upload_folder(r'C:\app\media\maps', 'maps')
upload_folder(r'C:\app\media\masks', 'masks')