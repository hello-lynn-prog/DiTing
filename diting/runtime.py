"""dsh integration discovery. Do not substitute mock execution for missing plugins."""
import importlib.util
from pathlib import Path


class RuntimeRegistry:
    def __init__(self, settings):
        self.settings = settings

    def capabilities(self):
        root = self.settings.dsh_root
        reference = self.settings.template_reference_root
        sdk_available = importlib.util.find_spec("deepseek_harness") is not None
        templates = list((reference / "report_template").glob("*.md")) if reference else []
        return {
            "dsh": {"source_found": bool(root and root.is_dir()), "sdk_installed": sdk_available,
                    "certified_executor": False},
            "template_reference": {"source_found": bool(reference and reference.is_dir()),
                          "templates_found": len(templates), "migrated": False},
            "ready": False,
            "reason": "旧版 Python 执行适配未联合认证；正式研究请使用 TypeScript 服务。",
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

