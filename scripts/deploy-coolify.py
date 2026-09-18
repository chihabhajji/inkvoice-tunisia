"""Wait for Coolify's signed GitHub push webhook to deploy the tested commit."""
import json
import subprocess
import time
import urllib.error
import urllib.request

sha = subprocess.check_output(["git", "rev-parse", "HEAD"], text=True).strip()
print("Waiting for healthy deployment of", sha, flush=True)
for _ in range(120):
    try:
        request = urllib.request.Request(
            "https://accounting.washere.cloud/health",
            headers={"Cache-Control": "no-cache"},
        )
        with urllib.request.urlopen(request, timeout=15) as response:
            health = json.load(response)
        if health.get("status") == "ok" and health.get("commit") == sha:
            print("Tested commit is deployed and healthy.")
            break
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError):
        pass  # Rolling deployment may briefly be unavailable.
    time.sleep(10)
else:
    raise SystemExit("Tested commit did not become healthy; inspect Coolify deployment logs and retry deployment.")
