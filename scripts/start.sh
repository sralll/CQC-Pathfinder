#!/bin/bash

# Runtime should only start the app. Node dependencies for OCAD import are
# installed during the build phase.

gunicorn CQCPathfinder.asgi:application \
  -k uvicorn.workers.UvicornWorker \
  --bind 0.0.0.0:$PORT \
  --preload \
  --workers 2 \
  --max-requests 100 \
  --max-requests-jitter 10 \
  --timeout 30 \
  --graceful-timeout 600 \
  --log-level info
