#!/bin/bash

uvicorn CQCPathfinder.asgi:application --host 0.0.0.0 --port $PORT --workers 1