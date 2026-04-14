#!/bin/bash

gunicorn CQCPathfinder.asgi:application \
  -k uvicorn.workers.UvicornWorker \
  --bind 0.0.0.0:$PORT \
  --workers 4 \
  --max-requests 5 \
  --max-requests-jitter 1 \
  --timeout 30 \
  --graceful-timeout 900 \
  --log-level info