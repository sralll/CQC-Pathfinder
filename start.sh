#!/bin/bash

gunicorn CQCPathfinder.asgi:application \
  -k uvicorn.workers.UvicornWorker \
  --bind 0.0.0.0:$PORT \
  --workers 2 \
  --max-requests 2000 \
  --max-requests-jitter 500 \
  --timeout 0 \
  --graceful-timeout 0 \
  --log-level info