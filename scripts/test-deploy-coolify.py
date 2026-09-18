"""Run with python3 scripts/test-deploy-coolify.py; no live deployment needed."""
import io
import json
import runpy
import unittest
import urllib.error
from pathlib import Path
from unittest.mock import patch

SCRIPT = str(Path(__file__).with_name("deploy-coolify.py"))


class DeploymentCheck(unittest.TestCase):
    def run_check(self, responses):
        with patch("subprocess.check_output", return_value="tested-sha"), patch(
            "urllib.request.urlopen", side_effect=responses
        ) as fetch, patch("time.sleep"):
            runpy.run_path(SCRIPT)
        return fetch.call_count

    def test_waits_for_tested_commit_and_healthy_database(self):
        bodies = [
            {"status": "ok", "commit": "old-sha"},
            {"status": "degraded", "commit": "tested-sha"},
            {"status": "ok", "commit": "tested-sha"},
        ]
        responses = [urllib.error.URLError("rolling restart")]
        responses.extend(io.BytesIO(json.dumps(body).encode()) for body in bodies)
        self.assertEqual(self.run_check(responses), 4)

    def test_failed_deployment_fails_the_workflow(self):
        responses = [urllib.error.URLError("unavailable")] * 120
        with self.assertRaises(SystemExit):
            self.run_check(responses)


if __name__ == "__main__":
    unittest.main()
