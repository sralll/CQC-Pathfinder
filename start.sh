#!/bin/bash

gunicorn CQCPathfinder.asgi:application \
  -k uvicorn.workers.UvicornWorker \
  --bind 0.0.0.0:$PORT \
  --workers 4 \
  --max-requests 500 \
  --max-requests-jitter 50 \
  --timeout 30 \
  --graceful-timeout 30 \
  --log-level info