import logging
from threading import Event, Thread
from uuid import uuid4

log = logging.getLogger(__name__)


class Worker:
    def __init__(self, service, registry, interval=1):
        self.service, self.registry, self.interval = service, registry, interval
        self.stop_event = Event()
        self.owner = uuid4().hex
        self.thread = None

    def tick(self):
        task = self.service.claim(self.owner)
        if task:
            # No stage changes, report or fake success until a certified executor exists.
            self.service.wait_runtime(task["id"], task["lease_owner"], self.registry.capabilities()["reason"])

    def start(self):
        self.thread = Thread(target=self._run, name="diting-queue", daemon=True)
        self.thread.start()

    def _run(self):
        while not self.stop_event.is_set():
            try:
                self.tick()
            except Exception:
                log.exception("queue tick failed")
            self.stop_event.wait(self.interval)

    def stop(self):
        self.stop_event.set()
        if self.thread:
            self.thread.join(timeout=5)
