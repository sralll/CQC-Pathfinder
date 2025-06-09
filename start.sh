#!/bin/bash

if [ "$RUN_BACKUP" = "true" ]; then
    echo "Running backup..."
    python manage.py backup_to_s3
    exit 0
fi

gunicorn CQCPathfinder.asgi:application -k uvicorn.workers.UvicornWorker --bind 0.0.0.0:$PORT
