"""dsh integration discovery. Do not substitute mock execution for missing plugins."""
import importlib.util
from pathlib import Path


class RuntimeRegistry:
    def __init__(self, settings):
        self.settings = settings

    def capabilities(self):
        root = self.settings.dsh_root
        betta = self.settings.bettafish_root
        sdk_available = importlib.util.find_spec("deepseek_harness") is not None
        templates = list((betta / "ReportEngine" / "report_template").glob("*.md")) if betta else []
        return {
            "dsh": {"source_found": bool(root and root.is_dir()), "sdk_installed": sdk_available,
                    "certified_executor": False},
            "bettafish": {"source_found": bool(betta and (betta / "ReportEngine" / "agent.py").is_file()),
                          "templates_found": len(templates), "migrated": False},
            "ready": False,
            "reason": "dsh 执行适配、舆情工具、BettaFish 三引擎与门禁尚未联合认证；任务已持久化，等待执行器接入。",
        }


class DshSdkAdapter:
    """Explicit SDK adapter, not selected by the worker until profile/tool acceptance passes.

    Each task has a separate workspace, Harness home and session. A returned assistant
    answer is an engine draft, NOT a verified report. This adapter is deliberately not
    an API endpoint for executing arbitrary user-supplied commands or profiles.
    """
    def __init__(self, data_dir: Path, profile: str, provider: str, model: str):
        self.data_dir, self.profile, self.provider, self.model = data_dir, profile, provider, model

    def run(self, task_id, prompt):
        from deepseek_harness import DeepSeekHarness
        if not task_id.startswith("task_") or not task_id.removeprefix("task_").isalnum():
            raise ValueError("invalid task id")
        workspace = self.data_dir / "workspaces" / task_id
        home = self.data_dir / "dsh" / task_id
        workspace.mkdir(parents=True, exist_ok=True)
        home.mkdir(parents=True, exist_ok=True)
        with DeepSeekHarness(provider=self.provider, model=self.model, profile=self.profile,
                             cwd=str(workspace.resolve()), dsh_home=str(home.resolve()),
                             request_timeout_seconds=1800) as harness:
            result = harness.run(prompt, session_id=task_id)
            return {"kind": "engine_draft", "text": result.final_response,
                    "session_id": result.session_id, "verified": False}

