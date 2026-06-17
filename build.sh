#!/usr/bin/env bash
set -o errexit

pip install -r requirements.txt
npm ci --omit=dev
python manage.py collectstatic --no-input

# Apply any outstanding database migrations
python manage.py migrate
