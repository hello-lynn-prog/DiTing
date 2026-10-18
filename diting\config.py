from dataclasses import dataclass
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def existing(path):
    return path if path.is_dir() else None


@dataclass(frozen=True)
class Settings:
    data_dir: Path = ROOT / "data"
    bettafish_root: Path | None = None
    dsh_root: Path | None = None
    default_budget: float = 20.0
    worker_interval: float = 1.0

    @classmethod
    def from_env(cls):
        def path(key):
            return Path(os.environ[key]).expanduser().resolve() if os.environ.get(key) else None
        return cls(
            data_dir=path("DITING_DATA_DIR") or ROOT / "data",
            bettafish_root=path("DITING_BETTAFISH_ROOT") or existing(Path("D:/工作学习/9github项目/agent-code-atlas-output/repos/BettaFish")),
            dsh_root=path("DITING_DSH_ROOT") or existing(Path("D:/Study/deepseek_harness/deepseek-harness")),
            default_budget=float(os.environ.get("DITING_DEFAULT_BUDGET", "20")),
        )

