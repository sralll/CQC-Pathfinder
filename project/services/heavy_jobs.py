"""Concurrency gate for heavy background jobs (MEM-1).

Navgraph rebuilds (full-res mask + numpy/scipy/skimage arrays) and UNet mask
generation (ONNX inference on images up to 16000x16000) are the two dominant
memory consumers in the process. Railway bills per GB-minute and each container
preloads two uvicorn workers, so letting several of these run concurrently
multiplies peak RSS. This semaphore is created before Gunicorn forks its
preloaded workers, so it lets at most one such job hold large arrays at a time
*per container*; further jobs simply block in their (cheap) worker threads and
start when the slot frees — nothing is rejected.

A semaphore acquired inside the worker functions is used instead of a shared
``ThreadPoolExecutor`` so each job keeps its existing thread daemon semantics:

* navgraph builds stay ``daemon=True`` — safe to kill at interpreter exit,
  because the build token plus the atomic publish step make an aborted build
  invisible;
* mask generation stays ``daemon=False`` — it must survive shutdown long
  enough to finish writing the mask file, exactly as before.

Executor threads are always non-daemon and joined at interpreter exit, which
would additionally force shutdown to wait for *queued* navgraph builds; the
semaphore avoids that. The production start command uses ``--preload`` so the
semaphore is inherited by both web workers. A separate container/replica has
its own gate, as expected for an in-process worker design.

``_OCAD_CONVERSION_EXECUTOR`` (project/views.py) stays separate on purpose:
OCAD conversions are comparatively light and must not queue behind a
long-running navgraph build.
"""

import multiprocessing

# Created while Gunicorn's preloaded master imports the application, then
# inherited by its worker processes. It is also safe to acquire from threads.
HEAVY_JOB_SLOT = multiprocessing.BoundedSemaphore(1)
