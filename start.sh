#!/bin/bash

gunicorn CQCPathfinder.asgi:application \
  -k uvicorn.workers.UvicornWorker \
  --bind 0.0.0.0:$PORT \
  --workers 1 \
  --timeout 0 \
  --graceful-timeout 0 \
  --log-level info