"""In-process snapshot/news fan-out shared by live and demo offices."""
from collections import deque
import hashlib
import json
import threading
import time

from .sessions import redact


def public(value):
    """Redact strings at the public boundary, including configurable labels and event text."""
    if isinstance(value, dict):
        return {k: public(v) for k, v in value.items()
                if k.lower() not in {"accesstoken", "refreshtoken", "password", "secret", "api_key"}}
    if isinstance(value, (list, tuple)):
        return [public(v) for v in value]
    return redact(value)


class LiveOffice:
    def init_live(self):
        self.started_at = time.time()
        self.condition = threading.Condition(threading.RLock())
        self._lock = self.condition
        self._streams = set()
        self._state_hash = None
        self._state_json = "{}"

    def publish(self, snapshot):
        snapshot = public(snapshot)
        payload = json.dumps(snapshot, separators=(",", ":"), sort_keys=True)
        content = json.dumps({k: v for k, v in snapshot.items() if k != "now"},
                             separators=(",", ":"), sort_keys=True)
        digest = hashlib.sha256(content.encode()).digest()
        with self.condition:
            self.snapshot = snapshot
            self._state_json = payload
            if digest != self._state_hash:
                self._state_hash = digest
                self.condition.notify_all()
        return snapshot

    def subscribe(self):
        with self.condition:
            if len(self._streams) >= 8:
                return None
            client = StreamClient()
            self._streams.add(client)
            return client, self._state_hash, self._state_json

    def unsubscribe(self, client):
        with self.condition:
            self._streams.discard(client)

    def notify_news(self, event):
        with self.condition:
            payload = json.dumps(public(event), separators=(",", ":"))
            for client in self._streams:
                if len(client.news) >= 512:
                    client.closed = True
                else:
                    client.news.append(payload)
            self.condition.notify_all()

    def get(self):
        with self.condition:
            return self.snapshot


class StreamClient:
    def __init__(self):
        self.news = deque()
        self.closed = False
