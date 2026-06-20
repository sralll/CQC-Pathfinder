#!/bin/bash

# Runtime should only start the app. Node dependencies for OCAD import are
# installed during the build phase.

gunicorn CQCPathfinder.asgi:application \
  -k uvicorn.workers.UvicornWorker \
  --bind 0.0.0.0:$PORT \
  --workers 4 \
  --max-requests 50 \
  --max-requests-jitter 5 \
  --timeout 30 \
  --graceful-timeout 900 \
  --log-level info
