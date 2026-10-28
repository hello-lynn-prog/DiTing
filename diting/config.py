from dataclasses import dataclass
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def existing(path):
    return path if path.is_dir() else None


@dataclass(frozen=True)
class Settings:
    data_dir: Path = ROOT / "data"
    template_reference_root: Path | None = None
    dsh_root: Path | None = None
    default_budget: float = 20.0
    worker_interval: float = 1.0
    newsnow_base_url: str = "http://127.0.0.1:3000"
    dailyhot_base_url: str = "http://127.0.0.1:6688"
    source_timeout_seconds: float = 12.0

    @classmethod
    def from_env(cls):
        def path(key):
            return Path(os.environ[key]).expanduser().resolve() if os.environ.get(key) else None
        return cls(
            data_dir=path("DITING_DATA_DIR") or ROOT / "data",
            template_reference_root=path("DITING_TEMPLATE_REFERENCE_ROOT"),
            dsh_root=path("DITING_DSH_ROOT") or existing(Path("D:/Study/deepseek_harness/deepseek-harness")),
            default_budget=float(os.environ.get("DITING_DEFAULT_BUDGET", "20")),
            newsnow_base_url=os.environ.get("DITING_NEWSNOW_BASE_URL", "http://127.0.0.1:3000").rstrip("/"),
            dailyhot_base_url=os.environ.get("DITING_DAILYHOT_BASE_URL", "http://127.0.0.1:6688").rstrip("/"),
            source_timeout_seconds=float(os.environ.get("DITING_SOURCE_TIMEOUT_SECONDS", "12")),
        )

